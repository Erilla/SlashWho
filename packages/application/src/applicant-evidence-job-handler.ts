import type {
  CharacterMythicKillInput,
  CharacterTierBestParseInput,
  DiscoveryWorkContext
} from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";
import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsGateway,
  WarcraftLogsLimitationCode,
  WarcraftLogsRateLimit,
  WarcraftLogsWipeEvidence
} from "@slashwho/warcraftlogs";

import { decryptCredential } from "./credential-encryption";
import { measuredRepositories } from "./measured-repositories";
import { createMeasurementScope } from "./measurement";
import { queueWaitMs } from "./queue-wait";

export type ApplicantEvidenceRun = Readonly<{
  id: string;
  key: CharacterKey;
  status: "queued" | "running" | "retrying" | "complete" | "partial" | "failed";
  createdAt: Date;
  wclClientIdEncrypted: string | null;
  wclClientSecretEncrypted: string | null;
  className?: string | null;
}>;

export type ApplicantEvidenceStore = {
  find(runId: string): Promise<ApplicantEvidenceRun | null>;
  claim(runId: string, attempt: number): Promise<ApplicantEvidenceRun | null>;
  publish(
    runId: string,
    result: Readonly<{
      state: "complete" | "partial";
      limitationCode: WarcraftLogsLimitationCode | null;
      parseLimitationCode: WarcraftLogsLimitationCode | null;
      retryAfterAt?: Date | null;
      kills: readonly CharacterMythicKillInput[];
      wipes: readonly WarcraftLogsWipeEvidence[];
      tierBests: readonly CharacterTierBestParseInput[];
      completedAt: Date;
    }>
  ): Promise<void>;
  fail(runId: string, code: WarcraftLogsLimitationCode): Promise<void>;
  /**
   * Fight URLs whose parses are already stored for this character, so a
   * budget-limited run spends its requests on what is still missing rather
   * than redoing the same reports on every run.
   */
  hydratedFightUrls(key: CharacterKey): Promise<readonly string[]>;
  /**
   * When each zone's tier bests were last collected, as `[raidId, completedAt]`
   * pairs, so a zone with nothing left to fetch neither spends a request nor
   * counts towards the run's zone budget.
   */
  collectedTierZones(
    key: CharacterKey
  ): Promise<readonly (readonly [string, string])[]>;
};

export type ApplicantEvidenceJobHandlerOptions = Readonly<{
  evidence: ApplicantEvidenceStore;
  warcraftLogs: Pick<
    WarcraftLogsGateway,
    "getFirstKillReports" | "getRateLimit"
  >;
  createWarcraftLogsGateway?: (credentials: {
    clientId: string;
    clientSecret: string;
  }) => Pick<WarcraftLogsGateway, "getFirstKillReports" | "getRateLimit">;
  decryptionKey?: Buffer;
  requestCap: number;
  parseRequestCap: number;
  /**
   * How long a run that exhausted its parse budget waits before it is
   * collectable again. A capped run records that work is outstanding, and
   * `retry_after_at` is the one signal that makes `reserve` hand it back: with
   * no retry the run stays fresh for the full 24 hours and the character
   * settles permanently short of the data it knows it did not fetch.
   */
  parseCapRetryMs: number;
  /**
   * How many Warcraft Logs points must remain unspent this hour before a run
   * may start. The gateway reports the allowance; this is the policy applied
   * to it.
   */
  pointsReserve: number;
  now?: () => Date;
  logger?: { info(value: Record<string, unknown>): void };
  monotonic?: () => number;
}>;

/**
 * Either a plain run id (existing callers) or a job payload carrying the
 * correlation id and enqueue time forwarded from the queue.
 */
export type ApplicantEvidenceJobInput =
  | string
  | Readonly<{
      runId: string;
      correlationId?: string;
      enqueuedAt?: string;
      /**
       * `light` reads only the most recent page of reports. A manual refresh
       * inside its cooldown uses it to look for a new raid night without
       * spending a whole history's worth of requests.
       */
      mode?: "full" | "light";
    }>;

function toCharacterMythicKillInput(
  kill: WarcraftLogsFirstKillEvidence
): CharacterMythicKillInput {
  return {
    raidId: kill.raidId,
    raidName: kill.raidName,
    bossId: kill.bossId,
    bossName: kill.bossName,
    journalBossId: kill.journalBossId,
    bossOrder: kill.bossOrder,
    isFinalBoss: kill.isFinalBoss,
    killedAt: kill.killedAt,
    reportUrl: kill.reportUrl,
    fightUrl: kill.fightUrl,
    guild: kill.guild,
    historicWorldRank: kill.historicWorldRank,
    performance: kill.performance
  };
}

// The queue's own ceiling. `requestedRetryDelaySeconds` rejects anything above
// `retryDelayMax` and the job then falls back to `retryDelay: 1` with backoff,
// retrying almost immediately into another refusal. `pointsResetIn` reaches
// 3600, so a long reset costs one extra attempt; by the second refusal the
// reset is necessarily within this window.
const MAXIMUM_REFUSAL_RETRY_SECONDS = 1_800;

type PointsBudgetRefusal = Error & {
  readonly retryable: true;
  readonly retryAfterMs: number;
  readonly code: "points_budget_low";
};

function pointsBudgetRefusal(resetInSeconds: number): PointsBudgetRefusal {
  // Whole seconds, at least 1 and at most 1800: outside that range
  // `requestedRetryDelaySeconds` returns null and the delay is discarded.
  const delaySeconds = Math.min(
    Math.max(Math.ceil(resetInSeconds), 1),
    MAXIMUM_REFUSAL_RETRY_SECONDS
  );
  return Object.assign(new Error("evidence_points_budget_low"), {
    retryable: true as const,
    retryAfterMs: delaySeconds * 1_000,
    code: "points_budget_low" as const
  });
}

/**
 * The final attempt asks for no retry: there is none left to schedule, and a
 * retryable error would send the queue to `updateActiveRetryDelay`, whose
 * `AND state = 'active'` matches no row once the job is failing. That throws,
 * replacing this refusal and losing the cause from the logs.
 */
function terminalPointsBudgetRefusal(): Error & {
  readonly code: "points_budget_low";
} {
  return Object.assign(new Error("evidence_points_budget_low"), {
    code: "points_budget_low" as const
  });
}

function isPointsBudgetRefusal(error: unknown): error is PointsBudgetRefusal {
  return (
    error instanceof Error &&
    (error as Partial<PointsBudgetRefusal>).code === "points_budget_low"
  );
}

function remainingPoints(budget: WarcraftLogsRateLimit): number {
  return budget.limitPerHour - budget.pointsSpentThisHour;
}

/**
 * Collects one character's complete public Warcraft Logs history outside the
 * web request deadline. Only normalized gateway facts are handed to storage.
 */
export function createApplicantEvidenceJobHandler(
  options: ApplicantEvidenceJobHandlerOptions
) {
  const now = options.now ?? (() => new Date());

  return {
    async execute(
      input: ApplicantEvidenceJobInput,
      context?: DiscoveryWorkContext
    ): Promise<void> {
      const job = typeof input === "string" ? { runId: input } : input;
      const monotonic = options.monotonic ?? (() => performance.now());
      const scope = createMeasurementScope(monotonic);
      const observedAt = monotonic();
      const activeContext = context ?? {
        attempt: 1,
        maxAttempts: 1,
        signal: new AbortController().signal
      };
      const evidence = measuredRepositories(
        { evidence: options.evidence },
        scope
      ).evidence;
      const record: Record<string, unknown> = {
        event: "evidence_job",
        runId: job.runId,
        correlationId: job.correlationId ?? null,
        queueWaitMs: queueWaitMs(job.enqueuedAt, now()),
        attempt: activeContext.attempt,
        outcome: "unknown",
        limitationCode: null,
        parseLimitationCode: null,
        killCount: 0,
        requestCapUsed: options.requestCap,
        pointsLimitPerHour: null,
        pointsRemainingBefore: null,
        pointsSpentByRun: null,
        pointsRemainingAfter: null,
        durationMs: 0
      };

      try {
        const run = await evidence.claim(job.runId, activeContext.attempt);
        if (!run) {
          record.outcome = "not_claimed";
          return;
        }

        // The run's own Warcraft Logs credentials when the enqueuing visitor
        // supplied them, the worker's shared gateway otherwise. The decrypted
        // values are used to build the gateway and never leave this scope:
        // nothing derived from them reaches `record`.
        const gateway =
          run.wclClientIdEncrypted &&
          run.wclClientSecretEncrypted &&
          options.createWarcraftLogsGateway &&
          options.decryptionKey
            ? options.createWarcraftLogsGateway({
                clientId: decryptCredential(
                  run.wclClientIdEncrypted,
                  options.decryptionKey
                ),
                clientSecret: decryptCredential(
                  run.wclClientSecretEncrypted,
                  options.decryptionKey
                )
              })
            : options.warcraftLogs;

        // Read from `gateway`, not `options.warcraftLogs`: a run carrying a
        // visitor's own credentials spends *their* allowance, and the worker's
        // shared allowance says nothing about it.
        //
        // A limitation here does not refuse the run. We are no worse off than
        // before this gate existed, and a gate that fails closed on its own
        // transport errors could stop all collection permanently.
        const budgetBefore = await gateway.getRateLimit(activeContext.signal);
        const openingBudget =
          budgetBefore.kind === "rate_limit" ? budgetBefore : null;
        if (openingBudget) {
          record.pointsLimitPerHour = openingBudget.limitPerHour;
          record.pointsRemainingBefore = remainingPoints(openingBudget);
          if (remainingPoints(openingBudget) < options.pointsReserve) {
            // The run stays claimed and nothing is published. Leaving it
            // unclaimed instead would be a bug: `reserve` counts
            // ('queued','running','retrying') as active, so the character
            // would join a run that is never processed and never collect
            // again. Publishing instead risks the destructive merge of #250.
            record.outcome = "points_budget_low";
            record.limitationCode = "points_budget_low";
            if (activeContext.attempt >= activeContext.maxAttempts) {
              // The queue is about to give up, and a run abandoned in
              // `running` is never collected again: `reserve` counts
              // ('queued','running','retrying') as active with no staleness
              // cutoff, so it would block every later reservation for this
              // character. `failed` is in neither that set nor
              // `loadCompletedEvidence`'s ('complete','partial'), so the
              // character falls back to its previous evidence and a later
              // read reserves a fresh run.
              await evidence.fail(run.id, "points_budget_low");
              throw terminalPointsBudgetRefusal();
            }
            throw pointsBudgetRefusal(openingBudget.pointsResetInSeconds);
          }
        }

        activeContext.signal.throwIfAborted();
        const hydratedFightUrls = new Set(
          await options.evidence.hydratedFightUrls(run.key)
        );
        const collectedTierZones = new Map(
          await options.evidence.collectedTierZones(run.key)
        );
        activeContext.signal.throwIfAborted();
        // A light refresh reads one page of reports. The gateway marks a
        // page-capped scan as a request-cap limitation, so the run publishes
        // as partial and the kills it did not revisit are preserved.
        const requestCap = job.mode === "light" ? 1 : options.requestCap;
        const response = await scope.time("warcraftLogs", () =>
          gateway.getFirstKillReports(run.key, {
            requestCap,
            parseRequestCap: options.parseRequestCap,
            ...(run.className ? { className: run.className } : {}),
            hydratedFightUrls,
            collectedTierZones,
            signal: activeContext.signal
          })
        );
        activeContext.signal.throwIfAborted();

        // What the run actually cost. This is the measurement that replaces the
        // guessed reserve with evidence, so it is sampled even when the run was
        // limited. A negative `pointsSpentByRun` means the hourly window reset
        // mid-run; it is logged as observed rather than clamped away.
        const budgetAfter = await gateway.getRateLimit(activeContext.signal);
        if (budgetAfter.kind === "rate_limit") {
          record.pointsRemainingAfter = remainingPoints(budgetAfter);
          if (openingBudget) {
            record.pointsSpentByRun =
              budgetAfter.pointsSpentThisHour -
              openingBudget.pointsSpentThisHour;
          }
        }

        if (response.kind === "limitation") {
          record.outcome = "limitation";
          record.limitationCode = response.code;
          const retryAfterAt =
            response.retryAfterMs === undefined
              ? undefined
              : new Date(now().getTime() + response.retryAfterMs);
          await evidence.publish(run.id, {
            state: "partial",
            limitationCode: response.code,
            parseLimitationCode: null,
            ...(retryAfterAt ? { retryAfterAt } : {}),
            kills: [],
            wipes: [],
            tierBests: [],
            completedAt: now()
          });
          return;
        }

        // A cap carries no upstream retry hint -- it is our own budget, not a
        // 429 -- so the run supplies one. Without it `retry_after_at` stays
        // null, the run is fresh on the ordinary 24-hour rule, and nothing
        // ever collects the rest: the same machinery that resumes a
        // rate-limited run, which the cap simply was not using.
        const parseCapRetryMs =
          response.parseLimitation?.code === "parse_request_cap"
            ? options.parseCapRetryMs
            : 0;
        const retryAfterMs = Math.max(
          response.limitation?.retryAfterMs ?? 0,
          response.parseLimitation?.retryAfterMs ?? 0,
          parseCapRetryMs
        );
        // Honest about the run, not just about its history scan: a run that
        // spent its whole parse budget did not finish, and reporting it
        // `complete` was the other half of why the character looked settled.
        const incomplete = Boolean(
          response.limitation ?? response.parseLimitation
        );
        record.outcome = incomplete ? "partial" : "complete";
        record.limitationCode = response.limitation?.code ?? null;
        record.parseLimitationCode = response.parseLimitation?.code ?? null;
        record.killCount = response.kills.length;
        await evidence.publish(run.id, {
          state: incomplete ? "partial" : "complete",
          limitationCode: response.limitation?.code ?? null,
          parseLimitationCode: response.parseLimitation?.code ?? null,
          ...(retryAfterMs > 0
            ? { retryAfterAt: new Date(now().getTime() + retryAfterMs) }
            : {}),
          kills: response.kills.map(toCharacterMythicKillInput),
          wipes: response.wipes,
          tierBests: response.tierBests,
          completedAt: now()
        });
      } catch (error) {
        record.outcome = activeContext.signal.aborted
          ? "cancelled"
          : isPointsBudgetRefusal(error)
            ? "points_budget_low"
            : "unexpected_error";
        throw error;
      } finally {
        if (options.logger) {
          record.durationMs = Math.max(0, Math.round(monotonic() - observedAt));
          options.logger.info({ ...record, ...scope.totals() });
        }
      }
    }
  };
}

export type ApplicantEvidenceJobHandler = ReturnType<
  typeof createApplicantEvidenceJobHandler
>;
