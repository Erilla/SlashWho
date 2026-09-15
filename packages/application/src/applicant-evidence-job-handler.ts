import type {
  CharacterMythicKillInput,
  DiscoveryWorkContext
} from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";
import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsGateway,
  WarcraftLogsLimitationCode,
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
      completedAt: Date;
    }>
  ): Promise<void>;
  fail(runId: string, code: WarcraftLogsLimitationCode): Promise<void>;
};

export type ApplicantEvidenceJobHandlerOptions = Readonly<{
  evidence: ApplicantEvidenceStore;
  warcraftLogs: Pick<WarcraftLogsGateway, "getFirstKillReports">;
  createWarcraftLogsGateway?: (credentials: {
    clientId: string;
    clientSecret: string;
  }) => Pick<WarcraftLogsGateway, "getFirstKillReports">;
  decryptionKey?: Buffer;
  requestCap: number;
  parseRequestCap: number;
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

        activeContext.signal.throwIfAborted();
        const response = await scope.time("warcraftLogs", () =>
          gateway.getFirstKillReports(run.key, {
            requestCap: options.requestCap,
            parseRequestCap: options.parseRequestCap,
            ...(run.className ? { className: run.className } : {}),
            signal: activeContext.signal
          })
        );
        activeContext.signal.throwIfAborted();

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
            completedAt: now()
          });
          return;
        }

        const retryAfterMs = Math.max(
          response.limitation?.retryAfterMs ?? 0,
          response.parseLimitation?.retryAfterMs ?? 0
        );
        record.outcome = response.limitation ? "partial" : "complete";
        record.limitationCode = response.limitation?.code ?? null;
        record.parseLimitationCode = response.parseLimitation?.code ?? null;
        record.killCount = response.kills.length;
        await evidence.publish(run.id, {
          state: response.limitation ? "partial" : "complete",
          limitationCode: response.limitation?.code ?? null,
          parseLimitationCode: response.parseLimitation?.code ?? null,
          ...(retryAfterMs > 0
            ? { retryAfterAt: new Date(now().getTime() + retryAfterMs) }
            : {}),
          kills: response.kills.map(toCharacterMythicKillInput),
          wipes: response.wipes,
          completedAt: now()
        });
      } catch (error) {
        record.outcome = activeContext.signal.aborted
          ? "cancelled"
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
