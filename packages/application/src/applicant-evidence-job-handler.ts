import type {
  CharacterMythicKillInput,
  CharacterTierBestParseInput,
  DiscoveryWorkContext,
  StagedEvidenceCollection,
  StoredEvidenceTiers,
  TerminalTier
} from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";
import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsGateway,
  WarcraftLogsLimitationCode,
  WarcraftLogsQueryType,
  WarcraftLogsRateLimit,
  WarcraftLogsWipeEvidence
} from "@slashwho/warcraftlogs";

import { decryptCredential } from "./credential-encryption";
import { errorFields } from "./error-fields";
import {
  classifyEvidenceFailure,
  evidenceRetryDecision
} from "./evidence-retry-policy";
import { retryDelayMsFor } from "./limitation-retry-policy";
import { measuredRepositories } from "./measured-repositories";
import { createMeasurementScope } from "./measurement";
import { queueWaitMs } from "./queue-wait";
import {
  fromStagedCollection,
  terminalTiersFromStage,
  toStagedCollection,
  type EvidenceLimitationCode,
  type EvidencePublication
} from "./evidence-publication";
import { killScanFloorFrom, terminalTiersFrom } from "./terminal-tiers";

export type ApplicantEvidenceRun = Readonly<{
  id: string;
  key: CharacterKey;
  status: "queued" | "running" | "retrying" | "complete" | "partial" | "failed";
  createdAt: Date;
  wclClientIdEncrypted: string | null;
  wclClientSecretEncrypted: string | null;
  className?: string | null;
}>;

export type { EvidenceLimitationCode };

export type ApplicantEvidenceStore = {
  find(runId: string): Promise<ApplicantEvidenceRun | null>;
  claim(runId: string, attempt: number): Promise<ApplicantEvidenceRun | null>;
  publish(
    runId: string,
    result: Readonly<{
      state: "complete" | "partial";
      limitationCode: EvidenceLimitationCode | null;
      parseLimitationCode: EvidenceLimitationCode | null;
      retryAfterAt?: Date | null;
      kills: readonly CharacterMythicKillInput[];
      wipes: readonly WarcraftLogsWipeEvidence[];
      tierBests: readonly CharacterTierBestParseInput[];
      completedAt: Date;
    }>
  ): Promise<void>;
  fail(runId: string, code: EvidenceLimitationCode): Promise<void>;
  /**
   * Records why a still-active run collected nothing. A refusal publishes
   * nothing, so this is the only way the reason reaches a reader.
   */
  recordLimitation(runId: string, code: EvidenceLimitationCode): Promise<void>;
  /**
   * Holds a finished collection between the scan that paid for it and the
   * publication that stores it, so a retry republishes rather than re-collects.
   */
  stageCollection(
    runId: string,
    payload: StagedEvidenceCollection
  ): Promise<void>;
  /** The stage this run already holds, if a previous attempt left one. */
  stagedCollection(runId: string): Promise<StagedEvidenceCollection | null>;
  /**
   * Fight URLs whose parses are already stored for this character, so a
   * budget-limited run spends its requests on what is still missing rather
   * than redoing the same reports on every run.
   */
  hydratedFightUrls(
    key: CharacterKey,
    settledBefore: Date
  ): Promise<readonly string[]>;
  /**
   * The tiers this character is finished with, so the run spends no request on
   * them, and the means to record the ones it has just finished with.
   */
  /**
   * Where and when this character's stored kills and wipes happened, which is
   * what turns a terminal raid id into a date the report scan can stop at.
   */
  storedEvidenceTiers(key: CharacterKey): Promise<StoredEvidenceTiers>;
  terminalTiers(key: CharacterKey): Promise<readonly TerminalTier[]>;
  markTerminalTiers(
    key: CharacterKey,
    tiers: readonly TerminalTier[],
    at: Date
  ): Promise<void>;
  /**
   * When each zone's tier bests were last collected, as `[raidId, completedAt]`
   * pairs, so a zone with nothing left to fetch neither spends a request nor
   * counts towards the run's zone budget.
   */
  collectedTierZones(
    key: CharacterKey
  ): Promise<readonly (readonly [string, string])[]>;
};

/**
 * Announces an evidence run to whoever is watching. Evidence runs spend the
 * Warcraft Logs allowance, so a run that starts, stalls or drains it should be
 * visible without anyone deliberately querying for it.
 *
 * Both calls carry only what `evidence_job` already records: run identity, the
 * canonical (public) character key, the attempt and the outcome. Never the
 * run's credentials, an owner id or a correlation id.
 *
 * Delivery is the implementation's problem and is best effort. The handler
 * treats either call throwing as a non-event.
 */
export type EvidenceRunNotifier = {
  started(run: {
    runId: string;
    region: string;
    realm: string;
    name: string;
    attempt: number;
  }): Promise<void> | void;
  finished(run: {
    runId: string;
    region: string;
    realm: string;
    name: string;
    attempt: number;
    outcome: string;
    limitationCode: string | null;
    parseLimitationCode: string | null;
    pointsSpent: number | null;
    /** Whether this attempt earned another one, and why. */
    retryDecision?: string;
    retryReason?: string | null;
  }): Promise<void> | void;
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
   * How long a run that exhausted one of its own request budgets waits before
   * it is collectable again. A capped run records that work is outstanding,
   * and `retry_after_at` is the one signal that makes `reserve` hand it back:
   * with no retry the run stays fresh for the full 24 hours and the character
   * settles permanently short of the data it knows it did not fetch.
   */
  capRetryMs: number;
  /**
   * How long a run stopped by something outside itself -- an unreachable
   * upstream, or throttling that carried no `Retry-After` -- waits before it
   * is collectable again. Applied only where upstream supplied no hint of its
   * own; see `retryDelayMsFor` for which codes get one and which are left
   * alone.
   */
  transientRetryMs: number;
  /**
   * How many Warcraft Logs points must remain unspent this hour before a run
   * may start. The gateway reports the allowance; this is the policy applied
   * to it.
   */
  pointsReserve: number;
  /**
   * How long after a kill its rankings are taken to have settled. A kill
   * younger than this is re-read rather than frozen, and its tier cannot go
   * terminal.
   *
   * The default of seven days is a guess, like `EVIDENCE_POINTS_RESERVE`. Two
   * attempts to measure the settling period retrospectively failed, so the
   * observation times now stored alongside each percentile are what should
   * eventually replace it.
   */
  killSettleMs: number;
  /**
   * Points above which a failed attempt is not retried, whatever kind of fault
   * it was. A retry that repeats a 2,500-point collection is not comparable to
   * one that repeats a cheap request, and #292 paid for five of the former.
   * 0 switches the veto off.
   */
  retryCostCeiling: number;
  /**
   * How long a run that stopped on a fault waits before a reader may reserve
   * another. `failed` is invisible to `reserve` -- neither active nor
   * completed -- so a run that stops without this is re-reserved by the very
   * next page read, and a retry storm becomes a reservation storm.
   */
  failureCooldownMs: number;
  now?: () => Date;
  logger?: { info(value: Record<string, unknown>): void };
  evidenceRunNotifier?: EvidenceRunNotifier;
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

/**
 * Log-field prefix per class of upstream Warcraft Logs request. A closed map
 * authored in source rather than a name derived from the query type, so every
 * field on the `evidence_job` record is greppable from the field name alone.
 */
const REQUEST_COUNTER_PREFIX: Readonly<Record<WarcraftLogsQueryType, string>> =
  {
    history_scan: "warcraftLogsHistoryScan",
    zone_rankings: "warcraftLogsZoneRankings",
    fight_parses: "warcraftLogsFightParses",
    ranking_identities: "warcraftLogsRankingIdentities"
  };

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
 * The configured reserve is sized for the worker's own allowance, but a run may
 * carry a visitor's credentials, and their account's limit is its own -- 3600
 * by default against the worker's 18000. Applied flat, a 5000 reserve fences
 * off a visitor's entire budget and refuses every run they could make.
 * Capping it at a share of the *reported* allowance keeps the intent -- leave
 * room for roughly one more run -- at any account size, and can only lower the
 * configured value, never raise it.
 *
 * The share is 0.3 because 0.1 was quietly deciding the reserve. At the
 * worker's 18000 it clipped any configured value to 1800, and #295 measured a
 * real collection at 862 to 4775 points (median 1609): a 1800 ceiling cannot
 * express "leave room for one more run" when one more run costs up to 4775.
 * 0.3 of 18000 is 5400, so the measured 5000 default now reaches the gate
 * intact, and a visitor's 3600 account keeps a 1080 reserve -- which the same
 * measurement says is about the least a collection can cost.
 */
const MAXIMUM_RESERVE_SHARE_OF_ALLOWANCE = 0.3;

function effectiveReserve(
  budget: WarcraftLogsRateLimit,
  configured: number
): number {
  return Math.min(
    configured,
    budget.limitPerHour * MAXIMUM_RESERVE_SHARE_OF_ALLOWANCE
  );
}

/**
 * Collects one character's complete public Warcraft Logs history outside the
 * web request deadline. Only normalized gateway facts are handed to storage.
 */
export function createApplicantEvidenceJobHandler(
  options: ApplicantEvidenceJobHandlerOptions
) {
  const now = options.now ?? (() => new Date());

  /**
   * How long this limitation should defer the character, or `null` for one
   * that waiting cannot help. An upstream `Retry-After` always wins: upstream
   * knows better than a configured default when upstream will be ready.
   */
  function retryDelayMs(
    limitation:
      | Readonly<{ code: WarcraftLogsLimitationCode; retryAfterMs?: number }>
      | null
      | undefined
  ): number | null {
    if (!limitation) return null;
    return (
      limitation.retryAfterMs ??
      retryDelayMsFor(limitation.code, {
        transientRetryMs: options.transientRetryMs,
        capRetryMs: options.capRetryMs
      })
    );
  }

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
        terminalTierCount: 0,
        requestCapUsed: options.requestCap,
        pointsLimitPerHour: null,
        pointsRemainingBefore: null,
        pointsSpentByRun: null,
        pointsRemainingAfter: null,
        // Present on every record so the shape does not change with the
        // outcome, and filled from whatever is caught below.
        errorName: null,
        errorCode: null,
        // Whether this attempt earned another one, and why. A closed
        // enumeration authored in source, like every other field here.
        retryDecision: null,
        retryReason: null,
        // How a stopped attempt left the run: published as partial, or failed
        // because the publication was itself what broke. `outcome` keeps
        // naming the fault, so neither answer displaces the other.
        stopDisposition: null,
        durationMs: 0
      };
      // Set once the run is claimed, and the sole gate on announcing: a run
      // this execution never owned is neither started nor finished.
      let announced: CharacterKey | undefined;
      // The catch needs all three: which run this attempt owns, whether it got
      // as far as spending the allowance, and how to find out what it spent.
      let claimedRunId: string | undefined;
      let collectionBegan = false;
      let sampleSpend: (() => Promise<void>) | undefined;

      try {
        const run = await evidence.claim(job.runId, activeContext.attempt);
        if (!run) {
          record.outcome = "not_claimed";
          return;
        }
        // Announcing only once the claim succeeds keeps one run to one pair of
        // announcements however many workers race for it, and is the first
        // point at which there is a character to name.
        announced = run.key;
        claimedRunId = run.id;
        try {
          await options.evidenceRunNotifier?.started({
            runId: job.runId,
            region: run.key.region,
            realm: run.key.realm,
            name: run.key.name,
            attempt: activeContext.attempt
          });
        } catch {
          options.logger?.info({
            event: "evidence_run_announcement_failed",
            runId: job.runId,
            phase: "started"
          });
        }

        // A previous attempt already paid for this collection upstream and
        // failed on the way to storage. Republishing it is the whole point of
        // the stage, so it happens before the admission gate: it spends
        // nothing, and refusing it for a low allowance would throw away work
        // already bought.
        const staged = await evidence.stagedCollection(run.id);
        if (staged) {
          record.outcome = "republished";
          record.limitationCode = staged.limitationCode;
          record.parseLimitationCode = staged.parseLimitationCode;
          record.killCount = staged.kills.length;
          await evidence.publish(run.id, fromStagedCollection(staged));
          // Marked here too, and for the same reason the collect path marks:
          // a republication that stored evidence and settled nothing left the
          // character re-paying for zones and scan pages the original run had
          // already earned the right to stop re-querying. Timed from the
          // stage's own `completedAt`, which is the instant the run that
          // collected it would have used.
          const stagedMarks = terminalTiersFromStage(
            staged,
            options.killSettleMs
          );
          record.terminalTierCount = stagedMarks.length;
          if (stagedMarks.length > 0) {
            await evidence.markTerminalTiers(
              run.key,
              stagedMarks,
              new Date(staged.completedAt)
            );
          }
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
          // A reserve of 0 is off, not "refuse once nothing remains": spend
          // overruns the limit (9058.65 against 9000 was observed), so the
          // remaining-points reading goes negative and a bare comparison would
          // gate hardest exactly when it was asked to stop.
          if (
            options.pointsReserve > 0 &&
            remainingPoints(openingBudget) <
              effectiveReserve(openingBudget, options.pointsReserve)
          ) {
            // The run stays claimed and nothing is published. Leaving it
            // unclaimed instead would be a bug: `reserve` counts
            // ('queued','running','retrying') as active, so the character
            // would join a run that is never processed and never collect
            // again. Publishing instead risks the destructive merge of #250.
            record.outcome = "points_budget_low";
            record.limitationCode = "points_budget_low";
            // Nothing is published, so the run row is the only place a reader
            // can learn why the dossier is waiting rather than collecting.
            await evidence.recordLimitation(run.id, "points_budget_low");
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

        // Storage happens in two steps on purpose: the stage records that the
        // scan has been paid for, so a publication that fails transiently is
        // retried from the stage rather than from Warcraft Logs. `publish`
        // deletes it in its own transaction.
        // The trouble sets travel with the publication because terminal
        // marking needs them and nothing a settled run stores records them. A
        // stage is read by a re-claimed retry and by the recovery sweep alike,
        // and neither has the gateway response that raised them.
        const stageAndPublish = async (
          publication: EvidencePublication,
          troubledRaidIds: StagedEvidenceCollection["troubledRaidIds"]
        ) => {
          await evidence.stageCollection(
            run.id,
            toStagedCollection(publication, troubledRaidIds)
          );
          await evidence.publish(run.id, publication);
        };

        // Sampled by the success path and by the catch alike: what a failed
        // attempt cost is exactly what decides whether another one is
        // affordable (#292). Never at the cost of the collection it measures --
        // a failure to measure leaves the record null, which is what happened.
        sampleSpend = async () => {
          try {
            const budgetAfter = await gateway.getRateLimit(
              activeContext.signal
            );
            if (budgetAfter.kind === "rate_limit") {
              record.pointsRemainingAfter = remainingPoints(budgetAfter);
              if (openingBudget) {
                record.pointsSpentByRun =
                  budgetAfter.pointsSpentThisHour -
                  openingBudget.pointsSpentThisHour;
              }
            }
          } catch {
            // Left as null on the record: unmeasured, which is what happened.
          }
        };

        activeContext.signal.throwIfAborted();
        // A fight whose rankings have not settled is re-read rather than left
        // frozen at whatever it showed on the night.
        const settledBefore = new Date(now().getTime() - options.killSettleMs);
        const hydratedFightUrls = new Set(
          await options.evidence.hydratedFightUrls(run.key, settledBefore)
        );
        const collectedTierZones = new Map(
          await options.evidence.collectedTierZones(run.key)
        );
        const storedTerminal = await options.evidence.terminalTiers(run.key);
        const terminalRaidIds = {
          kills: new Set(
            storedTerminal
              .filter((tier) => tier.domain === "kills")
              .map((tier) => tier.raidId)
          ),
          parses: new Set(
            storedTerminal
              .filter((tier) => tier.domain === "parses")
              .map((tier) => tier.raidId)
          ),
          tierBests: new Set(
            storedTerminal
              .filter((tier) => tier.domain === "tier_bests")
              .map((tier) => tier.raidId)
          )
        };
        // How far back the report scan still has to page. Pages below this can
        // only re-find evidence already stored, so the scan stops there.
        const storedEvidence = await options.evidence.storedEvidenceTiers(
          run.key
        );
        const killScanFloor = killScanFloorFrom(
          storedTerminal,
          storedEvidence.kills,
          storedEvidence.wipes
        );
        activeContext.signal.throwIfAborted();
        // A light refresh reads one page of reports. The gateway marks a
        // page-capped scan as a request-cap limitation, so the run publishes
        // as partial and the kills it did not revisit are preserved.
        const requestCap = job.mode === "light" ? 1 : options.requestCap;
        collectionBegan = true;
        const response = await scope.time("warcraftLogs", () =>
          gateway.getFirstKillReports(run.key, {
            requestCap,
            parseRequestCap: options.parseRequestCap,
            ...(run.className ? { className: run.className } : {}),
            hydratedFightUrls,
            collectedTierZones,
            terminalRaidIds,
            ...(killScanFloor ? { killScanFloor } : {}),
            // `warcraftLogsCalls` counts gateway invocations; one of those is
            // four classes of upstream request. Counting them apart is what
            // makes a run's points attributable to the history scan or to
            // rankings, rather than a total nobody can act on (#303).
            onRequest: (event) => {
              scope.increment(`${REQUEST_COUNTER_PREFIX[event.query]}Requests`);
              if (event.limited) {
                scope.increment(
                  `${REQUEST_COUNTER_PREFIX[event.query]}Limited`
                );
              }
            },
            signal: activeContext.signal
          })
        );
        activeContext.signal.throwIfAborted();

        // What the run actually cost. This is the measurement that replaces the
        // guessed reserve with evidence, so it is sampled even when the run was
        // limited. A negative `pointsSpentByRun` means the hourly window reset
        // mid-run; it is logged as observed rather than clamped away.
        // Never at the cost of the collection it is measuring. This is an extra
        // round trip standing between a finished scan and its publish, and the
        // gateway rethrows the abort reason -- a graceful shutdown landing in
        // this window would otherwise discard a run that has already spent its
        // whole request and parse budget.
        await sampleSpend();

        if (response.kind === "limitation") {
          record.outcome = "limitation";
          record.limitationCode = response.code;
          const limitationRetryMs = retryDelayMs(response);
          const retryAfterAt =
            limitationRetryMs === null
              ? undefined
              : new Date(now().getTime() + limitationRetryMs);
          // Empty rather than absent, and it changes nothing either way: a
          // stage carrying a scan limitation settles no tier in any domain,
          // because a scan that went wrong may be missing reports from any.
          await stageAndPublish(
            {
              state: "partial",
              limitationCode: response.code,
              parseLimitationCode: null,
              ...(retryAfterAt ? { retryAfterAt } : {}),
              kills: [],
              wipes: [],
              tierBests: [],
              completedAt: now()
            },
            { parses: [], tierBests: [] }
          );
          return;
        }

        // Whichever limitation asks to wait longest decides, because the run
        // is not collectable again until both are. A limitation with no answer
        // at all contributes nothing rather than forcing a retry the code was
        // deliberately not given.
        const retryAfterMs = Math.max(
          retryDelayMs(response.limitation) ?? 0,
          retryDelayMs(response.parseLimitation) ?? 0
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
        await stageAndPublish(
          {
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
          },
          response.troubledRaidIds
        );

        // Marked only after publication succeeded. A mark that outlived a
        // failed publish would stop the tier being collected while nothing
        // was stored for it.
        const marks = terminalTiersFrom({
          at: now(),
          settleMs: options.killSettleMs,
          kills: response.kills,
          scanLimitation: response.limitation?.code ?? null,
          troubledRaidIds: response.troubledRaidIds
        });
        record.terminalTierCount = marks.length;
        if (marks.length > 0) {
          await evidence.markTerminalTiers(run.key, marks, now());
        }
      } catch (error) {
        const aborted = activeContext.signal.aborted;
        record.outcome = aborted
          ? "cancelled"
          : isPointsBudgetRefusal(error)
            ? "points_budget_low"
            : "unexpected_error";
        // Recorded for every caught error, not only the unexplained ones: the
        // outcome says which branch was taken, and this says what was thrown
        // to get there. Bounded to an error class and a code-authored
        // identifier -- see `errorFields` -- so no message text reaches a log.
        Object.assign(record, errorFields(error));

        // What this attempt cost is half the decision, so measure it before
        // deciding -- unless the run was cancelled, where the abort would only
        // reject this call too.
        if (
          !aborted &&
          collectionBegan &&
          record.pointsSpentByRun === null &&
          sampleSpend
        ) {
          await sampleSpend();
        }

        const decision = evidenceRetryDecision({
          classification: classifyEvidenceFailure(error, { aborted }),
          attempt: activeContext.attempt,
          maxAttempts: activeContext.maxAttempts,
          pointsSpent: record.pointsSpentByRun as number | null,
          collectionBegan,
          costCeiling: options.retryCostCeiling
        });
        record.retryDecision = decision.action;
        record.retryReason = decision.reason;

        // Rethrowing is what schedules the retry. A run this attempt never
        // claimed has nothing to publish onto either way.
        if (decision.action === "retry" || claimedRunId === undefined) {
          throw error;
        }

        // Stopping means publishing what there is rather than abandoning the
        // run: `publish` carries a partial's previous kills, wipes and parses
        // forward, so this can only add. `retryAfterAt` is what keeps the next
        // page read from reserving straight over the top of it.
        const stopped: EvidencePublication = {
          state: "partial",
          limitationCode: "collection_failed",
          parseLimitationCode: null,
          retryAfterAt: new Date(now().getTime() + options.failureCooldownMs),
          kills: [],
          wipes: [],
          tierBests: [],
          completedAt: now()
        };
        try {
          await evidence.publish(claimedRunId, stopped);
          record.stopDisposition = "published";
        } catch {
          // Publication is itself what is broken -- #290's case, where the
          // guard threw before any query. The run still has to leave the
          // active set, or `reserve` counts it forever and the character never
          // collects again.
          record.stopDisposition = "failed";
          await evidence.fail(claimedRunId, "collection_failed");
        }
      } finally {
        if (options.logger) {
          record.durationMs = Math.max(0, Math.round(monotonic() - observedAt));
          options.logger.info({ ...record, ...scope.totals() });
        }
        if (announced) {
          // Read from `record`, so the announcement and the log can never
          // disagree about how the run ended.
          try {
            await options.evidenceRunNotifier?.finished({
              runId: job.runId,
              region: announced.region,
              realm: announced.realm,
              name: announced.name,
              attempt: activeContext.attempt,
              outcome: record.outcome as string,
              limitationCode: record.limitationCode as string | null,
              parseLimitationCode: record.parseLimitationCode as string | null,
              pointsSpent: record.pointsSpentByRun as number | null,
              ...(record.retryDecision
                ? { retryDecision: record.retryDecision as string }
                : {}),
              retryReason: record.retryReason as string | null
            });
          } catch {
            options.logger?.info({
              event: "evidence_run_announcement_failed",
              runId: job.runId,
              phase: "finished"
            });
          }
        }
      }
    }
  };
}

export type ApplicantEvidenceJobHandler = ReturnType<
  typeof createApplicantEvidenceJobHandler
>;
