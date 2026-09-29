import type {
  DiscoverCharacterJob,
  DiscoveryWorkContext,
  JobTelemetry,
  ObservationWriteInput,
  Repositories
} from "@slashwho/database";
import type {
  BlizzardGateway,
  BlizzardProfileRequestObserver
} from "@slashwho/blizzard";
import {
  canonicalCharacterId,
  characterGroupsErrorCode,
  deduplicateCharacters,
  discoverCharacter,
  discoverFingerprintMatches,
  type CharacterGuild,
  type CharacterKey,
  type DiscoveryOutcome,
  type RaiderIoGateway
} from "@slashwho/domain";

import { bestEffort } from "./best-effort";
import { excludeBlizzardSlotWait } from "./blizzard-slot-wait";
import { createBlizzardFingerprintAdapter } from "./blizzard-fingerprint-adapter";
import { measuredRepositories } from "./measured-repositories";
import {
  continuationCycleWrite,
  firstSweepCycleWrite,
  liveSweepCompletionWrite,
  raiderIoPublicationWrite
} from "./observation-writes";
import {
  BLIZZARD_FAST_CALL_MS,
  createMeasurementScope,
  type ExcludeFromBucket,
  type MeasurementScope
} from "./measurement";
import { queueWaitMs } from "./queue-wait";
import { bindThrottleScope } from "./throttle-attribution";

/**
 * Provider timing belongs on the gateway, not on the orchestrating domain
 * function: `discoverCharacter` and `discoverFingerprintMatches` also consult
 * the suppression list and the fingerprint sweep tables, and timing them whole
 * would count that database work inside the provider bucket as well as `dbMs`.
 * Wrapping the gateway keeps the buckets disjoint, matching the decorators the
 * dossier service already builds per request.
 */
function scopedRaiderIoGateway(
  gateway: RaiderIoGateway,
  scope: MeasurementScope
): RaiderIoGateway {
  // Each call is labelled with its operation name, so `raiderIoMaxCallName`
  // says which one set `raiderIoMaxCallMs`. Never with an argument: an owner
  // id or a profile guess must not reach the logs.
  return {
    getCharacter: (key, signal) =>
      scope.time(
        "raiderIo",
        () => gateway.getCharacter(key, signal),
        "getCharacter"
      ),
    getClaimedCharacters: (ownerId, signal) =>
      scope.time(
        "raiderIo",
        () => gateway.getClaimedCharacters(ownerId, signal),
        "getClaimedCharacters"
      ),
    resolveProfileGuess: (value, signal) =>
      scope.time(
        "raiderIo",
        () => gateway.resolveProfileGuess(value, signal),
        "resolveProfileGuess"
      )
  };
}

function scopedBlizzardGateway(
  gateway: BlizzardGateway,
  scope: MeasurementScope,
  monotonic: () => number
): BlizzardGateway {
  // The fingerprint budget is recorded through a callback the client invokes
  // mid-request, so that one database write is the only nesting that cannot be
  // hoisted out of the provider call; it is excluded from `blizzardMs` and
  // still counted in `dbMs`.
  const excludeObserver = (
    excluded: ExcludeFromBucket,
    onProfileRequest?: BlizzardProfileRequestObserver
  ): BlizzardProfileRequestObserver | undefined =>
    onProfileRequest === undefined
      ? undefined
      : () =>
          excluded(async () => {
            await onProfileRequest();
          });
  const excludeSlotWait = (excluded: ExcludeFromBucket) =>
    excludeBlizzardSlotWait(scope, monotonic, excluded);

  return {
    getGuildRoster: (root, signal, onProfileRequest) =>
      scope.time("blizzard", (excluded) =>
        gateway.getGuildRoster(
          root,
          signal,
          excludeObserver(excluded, onProfileRequest),
          excludeSlotWait(excluded)
        )
      ),
    getGuildRosterByIdentity: (guild, signal, onProfileRequest) =>
      scope.time("blizzard", (excluded) =>
        gateway.getGuildRosterByIdentity(
          guild,
          signal,
          excludeObserver(excluded, onProfileRequest),
          excludeSlotWait(excluded)
        )
      ),
    getAchievementFingerprint: (key, signal, onProfileRequest) =>
      scope.time("blizzard", (excluded) =>
        gateway.getAchievementFingerprint(
          key,
          signal,
          excludeObserver(excluded, onProfileRequest),
          excludeSlotWait(excluded)
        )
      ),
    getCompletedAchievements: (key, signal, onProfileRequest) =>
      scope.time("blizzard", (excluded) =>
        gateway.getCompletedAchievements(
          key,
          signal,
          excludeObserver(excluded, onProfileRequest),
          excludeSlotWait(excluded)
        )
      )
  };
}

/**
 * The work context a caller passes to `execute`. Widened with `JobTelemetry`
 * so a live queue delivery can carry the correlation id and enqueue time
 * through to the emitted record; a resumed run (no context supplied) simply
 * has neither.
 */
export type DiscoveryExecutionContext = DiscoveryWorkContext & JobTelemetry;

export type DiscoveryLogger = {
  info(value: Record<string, unknown>): void;
};

/** Delivery seam for a maintainer-owned alert integration (PagerDuty, email, etc.). */
export type FingerprintAlertNotifier = {
  notify(alert: {
    event:
      | "fingerprint_admission_blocked"
      | "fingerprint_reservation_pressure"
      | "fingerprint_blizzard_rate_limited"
      | "applicant_poll_failed"
      | "applicant_new_intents"
      | "applicant_backlog_pressure"
      | "applicant_input_truncated";
    details: Record<string, number>;
    applicant?: {
      battletag?: string | undefined;
      discordId?: string | undefined;
      characterName?: string | undefined;
      characterUrl: string;
      dossierUrl?: string;
    };
  }): Promise<void> | void;
};

/**
 * Delivery seam for announcing that a run has begun. Called once per execution
 * - a retry and a continuation each announce themselves - so a watcher sees the
 * work as it is attempted rather than only once it settles. The field set is
 * the same allowlist `DiscoveryRunRecord` keeps to: run identity, the canonical
 * public character key, and the attempt.
 */
export type DiscoveryRunNotifier = {
  started(run: {
    runId: string;
    region: string;
    realm: string;
    name: string;
    attempt: number;
  }): Promise<void> | void;
};

export type DiscoveryJobHandlerOptions = {
  repositories: Repositories;
  gateway: RaiderIoGateway;
  /** Optional only until worker credential composition lands in Task 6. */
  blizzardGateway?: BlizzardGateway;
  /** Optional only until worker credential composition lands in Task 6. */
  fingerprint?: {
    requestCap: number;
    hourlyBudget: number;
    cadenceMs: number;
    minimumCommon: number;
    minimumIdenticalPercent: number;
    /**
     * Candidate reads a sweep keeps outstanding at once. The Blizzard client
     * enforces the process-wide limits; this only lets a sweep use them.
     */
    readConcurrency?: number;
  };
  enqueueFingerprintAdmission?: (runId: string) => Promise<unknown>;
  /** Queues full WCL collection before a newly admitted fingerprint match is published. */
  enqueueFullEvidence?: (
    key: CharacterKey,
    /** The root of the discovery run that admitted the match. */
    root: CharacterKey
  ) => Promise<unknown>;
  requestCap: number;
  now?: () => Date;
  random?: () => number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxJobLifetimeMs?: number;
  maxAttempts?: number;
  negativeCacheTtlMs?: number;
  logger?: DiscoveryLogger;
  fingerprintAlertNotifier?: FingerprintAlertNotifier;
  discoveryRunNotifier?: DiscoveryRunNotifier;
  monotonic?: () => number;
};

/**
 * One operational record per discovery run. The field set is an allowlist: run
 * identity, the canonical (public) character key, the delivery attempt, and the
 * outcome. Never an owner id, a profile guess, an upstream body, or an IP.
 */
type DiscoveryRunRecord = {
  event: "discovery_run";
  runId: string;
  region: string;
  realm: string;
  name: string;
  attempt: number;
  outcome: string;
  state: string | null;
  limitationCode: string | null;
  characterCount: number;
  /** Guild reads this delivery's discovery lost to an upstream failure. */
  guildReadsDropped: number;
  durationMs: number;
  correlationId: string | null;
  queueWaitMs: number | null;
  fingerprintQueueWaitMs: number | null;
  fingerprintReservedRequests: number;
  fingerprintUsedRequests: number;
  fingerprintDurationMs: number;
};

export type RetryableDiscoveryError = Error & {
  retryable: true;
  retryAfterMs: number;
};

type FingerprintReleaseRetryableError = Error & {
  fingerprintReleaseRetryable: true;
};

function retryableError(retryAfterMs: number): RetryableDiscoveryError {
  return Object.assign(new Error("discovery_retryable"), {
    retryable: true as const,
    retryAfterMs
  });
}

function isRetryableDiscoveryError(
  error: unknown
): error is RetryableDiscoveryError {
  return (
    error instanceof Error &&
    "retryable" in error &&
    error.retryable === true &&
    "retryAfterMs" in error &&
    typeof error.retryAfterMs === "number"
  );
}

function fingerprintReleaseRetryableError(
  cause: unknown
): FingerprintReleaseRetryableError {
  return Object.assign(new Error("fingerprint_release_failed", { cause }), {
    fingerprintReleaseRetryable: true as const
  });
}

function isFingerprintReleaseRetryableError(
  error: unknown
): error is FingerprintReleaseRetryableError {
  return (
    error instanceof Error &&
    "fingerprintReleaseRetryable" in error &&
    error.fingerprintReleaseRetryable === true
  );
}

/**
 * Consecutive continuation cycles that may re-enqueue without advancing the
 * cursor before the chain gives up. A chain making progress is never bounded by
 * this -- the counter resets whenever the cursor moves -- so it only catches a
 * roster whose upstream is persistently failing, which would otherwise loop
 * through the admission gate forever burning the hourly budget.
 *
 * Giving up leaves the cursor set, so the next natural sweep of this root
 * resumes from where the chain stopped instead of restarting at candidate one.
 */
const MAX_CONTINUATION_NON_PROGRESS_CYCLES = 5;

/**
 * How long a continuation cycle that failed waits before the next one may be
 * admitted: doubling from two minutes with each consecutive failure, and never
 * sooner than the upstream's own Retry-After. Without it the admission gate is
 * almost always open, so a fault lasting under a minute spent every attempt
 * the give-up bound allows and abandoned the chain for good. The four retries
 * before give-up span half an hour. Capped at the hour the budget rolls over.
 */
function continuationRetryDelayMs(
  failures: number,
  retryAfterMs?: number
): number {
  const backoffMs = 2 * 60_000 * 2 ** Math.max(0, failures - 1);
  return Math.min(60 * 60_000, Math.max(backoffMs, retryAfterMs ?? 0));
}

/**
 * Queues the next cycle of every chain left with a cursor and no live
 * admission, and re-enqueues its admission job. A cycle that ends without
 * publishing queues its own successor, but a process that dies between the
 * cycle's release and that re-admission leaves nothing that would ever resume
 * the chain. A chain that already gave up stays given up. Returns how many
 * chains it queued.
 */
export async function recoverStrandedContinuations(
  repositories: Pick<Repositories, "fingerprintSweeps">,
  queue: { enqueueFingerprintAdmission(runId: string): Promise<unknown> },
  at: Date = new Date()
): Promise<number> {
  let recovered = 0;
  for (;;) {
    // Each batch leaves its chains with a waiting admission, so the next one
    // finds only chains it has not seen.
    const runIds =
      await repositories.fingerprintSweeps.requeueStrandedContinuations({
        at,
        maxFailures: MAX_CONTINUATION_NON_PROGRESS_CYCLES,
        limit: 100
      });
    for (const runId of runIds) {
      await queue.enqueueFingerprintAdmission(runId);
    }
    recovered += runIds.length;
    if (runIds.length < 100) return recovered;
  }
}

function historicalGuildsFromEvidence(
  evidenceSets: readonly Awaited<
    ReturnType<Repositories["evidence"]["getCompleted"]>
  >[]
): readonly CharacterGuild[] {
  const guilds = new Map<string, CharacterGuild>();
  for (const evidence of evidenceSets) {
    for (const kill of evidence?.kills ?? []) {
      const guild = kill.guild;
      // Rows stored before WCL supplied a guild region cannot safely address a
      // Blizzard namespace. They remain display evidence, just not sweep input.
      if (!guild?.region) continue;
      const id = `${guild.region}/${guild.realm}/${guild.name}`;
      if (!guilds.has(id)) {
        guilds.set(id, {
          name: guild.name,
          region: guild.region,
          realm: guild.realm
        });
      }
    }
  }
  return [...guilds.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, guild]) => guild);
}

export function createDiscoveryJobHandler(options: DiscoveryJobHandlerOptions) {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 1_800_000;
  const maxJobLifetimeMs = options.maxJobLifetimeMs ?? 1_800_000;
  const maxAttempts = options.maxAttempts ?? 5;
  const negativeCacheTtlMs = options.negativeCacheTtlMs ?? 300_000;
  const monotonic = options.monotonic ?? performance.now.bind(performance);

  function retrySchedule(
    createdAt: Date,
    failureTime: Date,
    attempt: number,
    attemptLimit: number,
    requestedDelayMs: number
  ): { retryAfterMs: number; nextRetryAt: Date } | null {
    const remainingLifetimeMs = Math.max(
      0,
      createdAt.getTime() + maxJobLifetimeMs - failureTime.getTime()
    );
    const retryAfterMs = Math.max(
      1_000,
      Math.ceil(Math.min(requestedDelayMs, maxRetryDelayMs) / 1_000) * 1_000
    );
    if (
      attempt >= attemptLimit ||
      retryAfterMs > maxRetryDelayMs ||
      retryAfterMs > remainingLifetimeMs
    ) {
      return null;
    }

    return {
      retryAfterMs,
      nextRetryAt: new Date(failureTime.getTime() + retryAfterMs)
    };
  }

  /**
   * Phase 1's best-effort observation write (#738). It runs after the
   * publication committed and after the run's timing log, and never throws,
   * so it cannot change an outcome. The write goes ahead whether or not the
   * job has been aborted; an abort only skips the group recompute, which the
   * hourly maintenance pass then covers. A failure logs its `stage`: a lost
   * write restarts the replay's three days, while a lost recompute heals in
   * the maintenance cycle.
   */
  async function writeCommittedObservations(
    write: ObservationWriteInput,
    signal: AbortSignal
  ): Promise<void> {
    const connections = options.repositories.characterConnections;
    if (!connections) return;
    let result: Awaited<ReturnType<typeof connections.writeObservations>>;
    try {
      result = await connections.writeObservations(write);
    } catch (error) {
      logObservationFailure("write", error);
      return;
    }
    if (result.unknownCharacters > 0) {
      try {
        options.logger?.info({
          event: "character_groups_write",
          unknownCharacters: result.unknownCharacters
        });
      } catch {
        // Best effort only, as below.
      }
    }
    if (signal.aborted) return;
    let mergedGroups: number;
    try {
      ({ mergedGroups } = await connections.recomputeGroupsOf(
        result.changedCharacterIds
      ));
    } catch (error) {
      logObservationFailure("recompute", error);
      return;
    }
    if (mergedGroups > 0) {
      try {
        // Counts only: which characters merged is for the replay to show.
        options.logger?.info({
          event: "character_groups_merged",
          stage: "publication",
          mergedGroups
        });
      } catch {
        // Best effort only, as below.
      }
    }
  }

  function logObservationFailure(
    stage: "write" | "recompute",
    error: unknown
  ): void {
    // Runs inside the handler's `finally`: a logger that throws here would
    // replace the run's own outcome, so it is swallowed.
    try {
      const errorCode = characterGroupsErrorCode(error);
      options.logger?.info({
        event: "character_groups_write_failed",
        stage,
        errorName: error instanceof Error ? error.name : "unknown",
        // The SQLSTATE (55P03 is a lock timeout) or the repository's own
        // code: what tells a transient failure from a real fault.
        ...(errorCode === undefined ? {} : { errorCode })
      });
    } catch {
      // Best effort only.
    }
  }

  return {
    async execute(
      runId: string,
      workContext?: DiscoveryExecutionContext,
      // The delivered job payload. Only `continuation` is read here; taking the
      // payload type lets the worker hand the job straight through.
      job?: Partial<DiscoverCharacterJob>
    ): Promise<void> {
      // Created before the first query so the run lookup and claim reach
      // `dbCalls` too; nothing else about the run depends on its lifetime.
      // `observedAt` moves up with it so `durationMs` still spans every
      // measured call and the buckets stay within it. The sweep's candidate
      // reads, and the budget writes inside them, overlap, so overlapping calls
      // share their wall time rather than each counting all of it; summed, the
      // buckets would run past `durationMs` on any sweep of real size.
      const observedAt = monotonic();
      const scope = createMeasurementScope(monotonic, {
        overlapping: "shared",
        fastCallThresholdMs: { blizzard: BLIZZARD_FAST_CALL_MS }
      });
      bindThrottleScope(scope);
      const repositories = measuredRepositories(options.repositories, scope);

      let context = workContext;
      if (!context) {
        const existing = await repositories.runs.find(runId);
        if (!existing) throw new Error("discovery_run_not_found");
        // A continuation resumes the sweep of a run that is already complete,
        // so it is the one caller allowed past this guard.
        if (
          !job?.continuation &&
          (existing.status === "complete" || existing.status === "failed")
        ) {
          return;
        }
        context = {
          attempt: existing.attempt + 1,
          maxAttempts,
          signal: new AbortController().signal
        };
      }

      // `claim` matches only active statuses, so it refuses the completed run a
      // continuation resumes; read the run directly instead.
      const run = job?.continuation
        ? await repositories.runs.find(runId)
        : await repositories.runs.claim(runId, context.attempt);
      if (!run) return;

      const startedAt = now();
      // Announcing a run is an operational side effect, so a notifier that
      // throws is recorded and stepped over rather than costing the run it was
      // announcing.
      await bestEffort(
        () =>
          options.discoveryRunNotifier?.started({
            runId,
            region: run.rootKey.region,
            realm: run.rootKey.realm,
            name: run.rootKey.name,
            attempt: context.attempt
          }),
        () =>
          options.logger?.info({
            event: "discovery_run_announcement_failed",
            runId
          })
      );
      const record: DiscoveryRunRecord = {
        event: "discovery_run",
        runId,
        region: run.rootKey.region,
        realm: run.rootKey.realm,
        name: run.rootKey.name,
        attempt: context.attempt,
        outcome: "unknown",
        state: null,
        limitationCode: null,
        characterCount: 0,
        guildReadsDropped: 0,
        durationMs: 0,
        correlationId: context.correlationId ?? null,
        queueWaitMs: queueWaitMs(context.enqueuedAt, startedAt),
        fingerprintQueueWaitMs: null,
        fingerprintReservedRequests: 0,
        fingerprintUsedRequests: 0,
        fingerprintDurationMs: 0
      };

      // Hoisted out of the try so the outer catch can tell a continuation from
      // an ordinary delivery: an unexpected throw mid-chain must re-enqueue,
      // not end the chain with the cursor still set.
      let resume: Awaited<
        ReturnType<Repositories["fingerprintSweeps"]["getResumeState"]>
      > = null;
      // Set only after a publication call resolves, which is only after its
      // transaction committed (#738). Written in the outer finally, so a
      // follow-up that throws, or an abort, cannot skip it.
      let pendingWrite: ObservationWriteInput | null = null;
      /**
       * Re-enqueues a continuation cycle that made no progress, giving up once
       * the same chain has done so too many times in a row. Returns true when
       * the chain was re-enqueued and false when it gave up.
       *
       * The admission job admits only a `waiting` row, and a cycle that did
       * not publish leaves none, so the next cycle's row is queued here: a
       * bare re-enqueue settled without dispatching and stranded the chain.
       */
      const continueWithoutProgress = async (
        retryAfterMs?: number
      ): Promise<boolean> => {
        const failures =
          await repositories.fingerprintSweeps.recordContinuationFailure(
            run.rootKey
          );
        if (failures >= MAX_CONTINUATION_NON_PROGRESS_CYCLES) return false;
        const at = now();
        await repositories.fingerprintSweeps.requeueContinuation(runId, {
          at,
          notBefore: new Date(
            at.getTime() + continuationRetryDelayMs(failures, retryAfterMs)
          )
        });
        await options.enqueueFingerprintAdmission?.(runId);
        return true;
      };

      try {
        context.signal.throwIfAborted();
        resume = job?.continuation
          ? await repositories.fingerprintSweeps.getResumeState(run.rootKey)
          : null;
        if (job?.continuation && !resume) {
          // The chain already sealed (or was never started): a benign no-op,
          // labelled so the logs do not read as an anomaly.
          record.outcome = "continuation_without_cursor";
          return;
        }
        if (resume && resume.runId !== runId) {
          // The cursor belongs to a different run's sweep -- a fresh refresh
          // for this root published its own snapshot and took the chain over.
          // Continuing would amend a snapshot this run does not own; discard
          // this cycle instead, leaving the live chain's cursor untouched.
          resume = null;
          record.outcome = "continuation_superseded";
          return;
        }

        /**
         * The job lifetime bounds one delivery of one run, measured from that
         * run's creation. A continuation resumes a run cycle 1 already
         * completed, possibly hours earlier while the hourly budget gated the
         * chain, so `run.createdAt` says nothing about how long this delivery
         * has taken. Applying the bound anyway would fail an already complete
         * run -- which throws, is swallowed by the outer catch, and abandons
         * the roster tail exactly as the bug this feature removes. Nothing is
         * lost: the chain is bounded by construction, because the cursor
         * advances strictly across a finite roster.
         */
        const withinJobLifetime = (at: Date): boolean =>
          resume !== null ||
          at.getTime() - run.createdAt.getTime() < maxJobLifetimeMs;

        const executionTime = startedAt;
        if (!withinJobLifetime(executionTime)) {
          record.outcome = "lifetime_exceeded";
          await repositories.runs.fail(runId, "upstream_unavailable");
          return;
        }

        const knownReverseDeclaredCharacters = resume
          ? []
          : await repositories.snapshots.listReverseDeclaredCharacters(
              run.rootKey
            );
        context.signal.throwIfAborted();
        let outcome: DiscoveryOutcome = resume
          ? {
              kind: "snapshot",
              state: "partial",
              // Placeholder only. A continuation performs no Raider.IO
              // discovery, so this value must never reach the snapshot: the
              // real limitation is `resume.limitationCode`, stored by cycle 1.
              limitationCode: "privacy_hidden",
              characters: [],
              guildReadsDropped: 0
            }
          : await discoverCharacter(
              run.rootKey,
              scopedRaiderIoGateway(options.gateway, scope),
              {
                requestCap: options.requestCap,
                isSuppressed: (key) => repositories.suppressions.isActive(key),
                knownReverseDeclaredCharacters,
                ...(job?.rootCharacter
                  ? { rootCharacter: job.rootCharacter }
                  : {}),
                signal: context.signal
              }
            );
        context.signal.throwIfAborted();
        if (!resume && outcome.kind === "snapshot") {
          record.guildReadsDropped = outcome.guildReadsDropped;
          // A new row already holds 0, so only a loss, or a redelivery that may
          // be replacing an earlier attempt's count, needs the write.
          if (outcome.guildReadsDropped > 0 || context.attempt > 1) {
            await repositories.runs.recordGuildReadsDropped(
              runId,
              outcome.guildReadsDropped
            );
          }
        }
        const persistenceTime = now();
        if (!withinJobLifetime(persistenceTime)) {
          record.outcome = "lifetime_exceeded";
          await repositories.runs.fail(runId, "upstream_unavailable");
          return;
        }

        if (outcome.kind === "snapshot") {
          let fingerprintFailure:
            Extract<DiscoveryOutcome, { kind: "failure" }> | undefined;
          const fingerprint = options.fingerprint;
          const blizzardGateway = options.blizzardGateway;
          if (fingerprint && blizzardGateway) {
            const admissionTime = now();
            const admission =
              await repositories.fingerprintSweeps.requestAdmission({
                runId,
                key: run.rootKey,
                requestCap: fingerprint.requestCap,
                hourlyBudget: fingerprint.hourlyBudget,
                cadenceCutoff: new Date(
                  admissionTime.getTime() - fingerprint.cadenceMs
                ),
                at: admissionTime,
                ...(resume ? { continuation: true as const } : {})
              });

            if (admission.kind === "waiting") {
              if (!options.enqueueFingerprintAdmission) {
                throw new Error("fingerprint_admission_queue_unavailable");
              }
              await options.enqueueFingerprintAdmission(runId);
              record.outcome = "fingerprint_admission_waiting";
              record.fingerprintQueueWaitMs = Math.max(
                0,
                admission.retryAt.getTime() - admissionTime.getTime()
              );
              const blockedForMs = admission.blockedSince
                ? Math.max(
                    0,
                    admissionTime.getTime() - admission.blockedSince.getTime()
                  )
                : 0;
              if (blockedForMs >= 15 * 60_000) {
                options.logger?.info({
                  event: "fingerprint_admission_blocked",
                  blockedForMs
                });
                await options.fingerprintAlertNotifier?.notify({
                  event: "fingerprint_admission_blocked",
                  details: { blockedForMs }
                });
              }
              return;
            }

            if (admission.kind === "not_due") {
              const live = await repositories.fingerprintSweeps.getResumeState(
                run.rootKey
              );
              if (live && live.runId !== runId) {
                // The snapshot belongs to the run that owns the cursor, so the
                // ordinary `complete` would refuse it as not this run's own.
                await repositories.runs.completeWithLiveSweepSnapshot(
                  runId,
                  live.snapshotId
                );
                pendingWrite = liveSweepCompletionWrite({
                  runId,
                  rootKey: run.rootKey,
                  characters: outcome.characters
                });
                record.outcome = "fingerprint_continuation_pending";
                return;
              }
            }

            if (admission.kind === "admitted") {
              const fingerprintStartedAt = monotonic();
              let reservationActive = true;
              record.fingerprintReservedRequests = admission.requestCap;
              if (
                admission.committedRequests !== undefined &&
                admission.hourlyBudget !== undefined &&
                admission.committedRequests > admission.hourlyBudget * 0.9
              ) {
                options.logger?.info({
                  event: "fingerprint_reservation_pressure",
                  committedRequests: admission.committedRequests,
                  hourlyBudget: admission.hourlyBudget
                });
                await options.fingerprintAlertNotifier?.notify({
                  event: "fingerprint_reservation_pressure",
                  details: {
                    committedRequests: admission.committedRequests,
                    hourlyBudget: admission.hourlyBudget
                  }
                });
              }
              const releaseReservation = async () => {
                if (!reservationActive) return;
                await repositories.fingerprintSweeps.release(
                  admission.reservationId,
                  now()
                );
                reservationActive = false;
              };
              try {
                const adaptedGateway = createBlizzardFingerprintAdapter(
                  scopedBlizzardGateway(blizzardGateway, scope, monotonic),
                  {
                    requestCap: admission.requestCap,
                    recordRequest: async () => {
                      await repositories.fingerprintSweeps.recordRequest(
                        admission.reservationId,
                        1,
                        now()
                      );
                      record.fingerprintUsedRequests += 1;
                    },
                    onRateLimited: async () => {
                      options.logger?.info({
                        event: "fingerprint_blizzard_rate_limited"
                      });
                      await options.fingerprintAlertNotifier?.notify({
                        event: "fingerprint_blizzard_rate_limited",
                        details: {}
                      });
                    }
                  }
                );
                const historicalGuilds = resume
                  ? resume.historicalGuilds
                  : historicalGuildsFromEvidence(
                      await Promise.all(
                        outcome.characters.map((character) =>
                          repositories.evidence.getCompleted(character.key)
                        )
                      )
                    );
                const sweep = await discoverFingerprintMatches(
                  run.rootKey,
                  adaptedGateway,
                  {
                    requestCap: Number.MAX_SAFE_INTEGER,
                    minimumCommon: fingerprint.minimumCommon,
                    minimumIdenticalPercent:
                      fingerprint.minimumIdenticalPercent,
                    isSuppressed: (key) =>
                      repositories.suppressions.isActive(key),
                    signal: context.signal,
                    historicalGuilds,
                    ...(fingerprint.readConcurrency === undefined
                      ? {}
                      : { readConcurrency: fingerprint.readConcurrency }),
                    ...(resume ? { resumeAfter: resume.resumeAfter } : {})
                  }
                );

                if (sweep.kind === "failure") {
                  await releaseReservation();
                  if (resume) {
                    // A continuation must never reach the run-retry machinery
                    // below: `markRetrying` and `fail` both assume an active
                    // run, and this one is already complete. The chain retries
                    // as a fresh continuation instead, throttled by the
                    // admission gate exactly as the `waiting` path already is,
                    // and bounded so a dead upstream cannot cycle forever.
                    record.outcome = (await continueWithoutProgress(
                      sweep.retryAfterMs
                    ))
                      ? "continuation_retrying"
                      : "continuation_abandoned";
                    return;
                  }
                  fingerprintFailure = sweep;
                } else {
                  // Cycle 1 learned which tournament profiles to leave out;
                  // every later cycle inherits that from the stored cursor.
                  const excludedTournamentCharacters = new Set(
                    resume
                      ? resume.excludedTournamentCharacterIds
                      : outcome.state === "partial"
                        ? outcome.excludedTournamentCharacterIds
                        : []
                  );
                  const sweepCharacters = sweep.characters.filter(
                    (character) =>
                      !excludedTournamentCharacters.has(
                        canonicalCharacterId(character.key)
                      )
                  );
                  const knownCharacterIds = new Set(
                    outcome.characters.map((character) =>
                      canonicalCharacterId(character.key)
                    )
                  );
                  if (resume) {
                    const published = await repositories.snapshots.find(
                      resume.snapshotId
                    );
                    for (const character of published?.characters ?? []) {
                      knownCharacterIds.add(
                        canonicalCharacterId(character.key)
                      );
                    }
                  }
                  const newlyAdmittedFingerprintMatches = deduplicateCharacters(
                    sweepCharacters
                  ).filter(
                    (character) =>
                      !knownCharacterIds.has(
                        canonicalCharacterId(character.key)
                      )
                  );
                  context.signal.throwIfAborted();
                  const fingerprintPersistenceTime = now();
                  if (!withinJobLifetime(fingerprintPersistenceTime)) {
                    record.outcome = "lifetime_exceeded";
                    await releaseReservation();
                    await repositories.runs.fail(runId, "upstream_unavailable");
                    return;
                  }
                  const stillSweeping =
                    sweep.kind === "capped" && sweep.resumeAfter !== undefined;
                  // The Raider.IO limitation this chain must restore when it
                  // seals. A continuation did no discovery of its own, so it
                  // uses the value cycle 1 stored rather than its placeholder.
                  const raiderIoLimitation = resume
                    ? resume.limitationCode
                    : outcome.state === "partial"
                      ? outcome.limitationCode
                      : null;
                  const limitationCode =
                    sweep.kind === "capped"
                      ? "fingerprint_sweep_capped"
                      : raiderIoLimitation;
                  const cursor = {
                    resumeAfter: stillSweeping
                      ? sweep.resumeAfter!
                      : sweep.kind === "capped"
                        ? (resume?.resumeAfter ?? null)
                        : null,
                    limitationCode: raiderIoLimitation,
                    historicalGuilds,
                    excludedTournamentCharacterIds: [
                      ...excludedTournamentCharacters
                    ],
                    // Progress is a cursor that moved or a roster exhausted.
                    // A `capped` that swept nothing re-stores the cursor it
                    // was given, and must not reset the give-up counter.
                    advanced: stillSweeping || sweep.kind === "matched"
                  };

                  // A fingerprint-derived relationship is only observable
                  // after its evidence work has been admitted. This also
                  // applies to continuations, which amend their already
                  // published snapshot with newly discovered members.
                  for (const character of newlyAdmittedFingerprintMatches) {
                    await options.enqueueFullEvidence?.(
                      character.key,
                      run.rootKey
                    );
                  }

                  if (resume) {
                    const amended =
                      await repositories.snapshots.amendAndFinishFingerprintSweep(
                        resume.snapshotId,
                        sweepCharacters,
                        {
                          runId,
                          reservationId: admission.reservationId,
                          finishedAt: now(),
                          limitationCode,
                          ...(cursor.resumeAfter === null
                            ? {}
                            : {
                                continuationAdmission: {
                                  requestCap: fingerprint.requestCap,
                                  hourlyBudget: fingerprint.hourlyBudget,
                                  cadenceCutoff: new Date(
                                    fingerprintPersistenceTime.getTime() -
                                      fingerprint.cadenceMs
                                  )
                                }
                              })
                        },
                        cursor,
                        { signal: context.signal }
                      );
                    if (amended === null) {
                      // The repository re-checked ownership under the root lock
                      // and found the chain taken over by a newer run while
                      // this cycle swept. Nothing was written; release the
                      // reservation and discard this cycle without
                      // re-enqueuing, exactly as a superseded continuation
                      // should end.
                      await releaseReservation();
                      record.outcome = "continuation_superseded";
                      return;
                    }
                    pendingWrite = continuationCycleWrite({
                      runId,
                      rootKey: run.rootKey,
                      sweep,
                      excludedTournamentIds: excludedTournamentCharacters,
                      reservationId: admission.reservationId
                    });
                  } else {
                    const characters = deduplicateCharacters([
                      ...outcome.characters,
                      ...sweep.characters
                    ]).filter(
                      (character) =>
                        !excludedTournamentCharacters.has(
                          canonicalCharacterId(character.key)
                        )
                    );
                    record.characterCount = characters.length;
                    await repositories.snapshots.createAndFinishFingerprintSweep(
                      {
                        runId,
                        rootKey: run.rootKey,
                        state: limitationCode === null ? "complete" : "partial",
                        limitationCode,
                        refreshedAt: fingerprintPersistenceTime,
                        characters
                      },
                      {
                        reservationId: admission.reservationId,
                        finishedAt: now(),
                        limitationCode,
                        ...(cursor.resumeAfter === null
                          ? {}
                          : {
                              continuationAdmission: {
                                requestCap: fingerprint.requestCap,
                                hourlyBudget: fingerprint.hourlyBudget,
                                cadenceCutoff: new Date(
                                  fingerprintPersistenceTime.getTime() -
                                    fingerprint.cadenceMs
                                )
                              }
                            })
                      },
                      cursor,
                      { signal: context.signal }
                    );
                    pendingWrite = firstSweepCycleWrite({
                      runId,
                      rootKey: run.rootKey,
                      raiderIoCharacters: outcome.characters,
                      raiderIoLimitation,
                      sweep,
                      excludedTournamentIds: excludedTournamentCharacters,
                      reservationId: admission.reservationId
                    });
                  }
                  record.outcome = "snapshot";
                  record.state =
                    limitationCode === null ? "complete" : "partial";
                  record.limitationCode = limitationCode;
                  reservationActive = false;
                  // Only `matched` seals the chain. A continuation therefore
                  // re-enqueues on any other result -- including a `capped`
                  // that swept nothing and so carries no new cursor, which
                  // would otherwise stall the chain with its tail unswept.
                  const sealed = sweep.kind === "matched";
                  if (resume) {
                    if (!sealed && !stillSweeping) {
                      // Capped without sweeping a single candidate: the cursor
                      // is unchanged, so this cycle counts against the bound.
                      if (!(await continueWithoutProgress())) {
                        record.outcome = "continuation_abandoned";
                      }
                    } else if (!sealed) {
                      await options.enqueueFingerprintAdmission?.(runId);
                    }
                  } else if (stillSweeping) {
                    await options.enqueueFingerprintAdmission?.(runId);
                  }
                  return;
                }
              } catch (error) {
                try {
                  await releaseReservation();
                } catch (releaseError) {
                  throw fingerprintReleaseRetryableError(releaseError);
                }
                throw error;
              } finally {
                record.fingerprintDurationMs = Math.max(
                  0,
                  monotonic() - fingerprintStartedAt
                );
              }
            }
          }

          if (fingerprintFailure) {
            outcome = fingerprintFailure;
          } else if (resume) {
            // A continuation that did not finish through the amend path has
            // nothing to publish: its outcome is a placeholder carrying no
            // characters, and the run it resumes is already complete. Reaching
            // the publication below would overwrite the snapshot this
            // continuation exists to extend. Only the sweep block above may
            // conclude a continuation; its `waiting` branch still re-enqueues
            // and returns on its own.
            //
            // Re-enqueue rather than return: the cursor is still set, so
            // stopping here would strand the roster tail for good. The
            // give-up counter bounds it if the sweep stays unavailable.
            record.outcome = (await continueWithoutProgress())
              ? "continuation_sweep_unavailable"
              : "continuation_abandoned";
            return;
          } else {
            context.signal.throwIfAborted();
            record.outcome = "snapshot";
            record.state = outcome.state;
            record.limitationCode =
              outcome.state === "partial" ? outcome.limitationCode : null;
            record.characterCount = outcome.characters.length;
            await repositories.snapshots.create(
              {
                runId,
                rootKey: run.rootKey,
                state: outcome.state,
                limitationCode:
                  outcome.state === "partial" ? outcome.limitationCode : null,
                refreshedAt: persistenceTime,
                characters: [...outcome.characters]
              },
              { signal: context.signal }
            );
            pendingWrite = raiderIoPublicationWrite({
              runId,
              rootKey: run.rootKey,
              characters: outcome.characters,
              limitationCode:
                outcome.state === "partial" ? outcome.limitationCode : null
            });
            return;
          }
        }

        if (!outcome.retryable) {
          record.outcome = outcome.code;
          if (outcome.code === "character_not_found") {
            context.signal.throwIfAborted();
            await repositories.negativeCache.putAndFailRun(
              run.rootKey,
              new Date(persistenceTime.getTime() + negativeCacheTtlMs),
              runId,
              { signal: context.signal }
            );
            return;
          }
          await repositories.runs.fail(runId, "search_failed");
          return;
        }

        const failureTime = now();
        const exponentialDelay =
          baseRetryDelayMs *
          2 ** Math.max(0, context.attempt - 1) *
          (0.5 + random() / 2);
        const schedule = retrySchedule(
          run.createdAt,
          failureTime,
          context.attempt,
          context.maxAttempts,
          Math.max(exponentialDelay, outcome.retryAfterMs ?? 0)
        );

        if (!schedule) {
          record.outcome = "upstream_unavailable";
          await repositories.runs.fail(runId, "upstream_unavailable");
          return;
        }
        record.outcome = "retrying";
        await repositories.runs.markRetrying(
          runId,
          context.attempt,
          schedule.nextRetryAt
        );
        throw retryableError(schedule.retryAfterMs);
      } catch (error) {
        if (
          context.signal.aborted &&
          !isFingerprintReleaseRetryableError(error)
        ) {
          record.outcome = "cancelled";
          throw context.signal.reason;
        }
        if (isRetryableDiscoveryError(error)) throw error;
        record.outcome = "unexpected_error";

        const current = await repositories.runs.find(runId);
        if (current?.status === "complete" || current?.status === "failed") {
          if (current.status === "complete") {
            // An unexpected throw mid-chain used to end here silently with the
            // cursor still set, abandoning the roster tail exactly as the bug
            // this feature removes. A continuation re-enqueues instead; the
            // give-up counter stops it looping on a permanent fault.
            if (resume) {
              record.outcome = (await continueWithoutProgress())
                ? "continuation_retrying"
                : "continuation_abandoned";
            }
            return;
          }
          throw error;
        }
        const failureTime = now();
        const schedule = retrySchedule(
          run.createdAt,
          failureTime,
          context.attempt,
          context.maxAttempts,
          baseRetryDelayMs * 2 ** Math.max(0, context.attempt - 1)
        );
        if (!schedule) {
          record.outcome = "search_failed";
          await repositories.runs.fail(runId, "search_failed");
          throw error;
        }

        record.outcome = "retrying";
        await repositories.runs.markRetrying(
          runId,
          context.attempt,
          schedule.nextRetryAt
        );
        throw retryableError(schedule.retryAfterMs);
      } finally {
        if (options.logger) {
          record.durationMs = Math.max(0, Math.round(monotonic() - observedAt));
          options.logger.info({ ...record, ...scope.totals() });
        }
        if (pendingWrite) {
          await writeCommittedObservations(pendingWrite, context.signal);
        }
      }
    }
  };
}

export type DiscoveryJobHandler = ReturnType<typeof createDiscoveryJobHandler>;
