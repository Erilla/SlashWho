import type {
  DiscoveryWorkContext,
  JobTelemetry,
  Repositories
} from "@slashwho/database";
import type {
  BlizzardGateway,
  BlizzardProfileRequestObserver
} from "@slashwho/blizzard";
import {
  canonicalCharacterId,
  deduplicateCharacters,
  discoverCharacter,
  discoverFingerprintMatches,
  type DiscoveryOutcome,
  type RaiderIoGateway
} from "@slashwho/domain";

import { createBlizzardFingerprintAdapter } from "./blizzard-fingerprint-adapter";
import { measuredRepositories } from "./measured-repositories";
import {
  createMeasurementScope,
  type ExcludeFromBucket,
  type MeasurementScope
} from "./measurement";
import { queueWaitMs } from "./queue-wait";

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
  return {
    getCharacter: (key, signal) =>
      scope.time("raiderIo", () => gateway.getCharacter(key, signal)),
    getClaimedCharacters: (ownerId, signal) =>
      scope.time("raiderIo", () =>
        gateway.getClaimedCharacters(ownerId, signal)
      ),
    resolveProfileGuess: (value, signal) =>
      scope.time("raiderIo", () => gateway.resolveProfileGuess(value, signal))
  };
}

function scopedBlizzardGateway(
  gateway: BlizzardGateway,
  scope: MeasurementScope
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

  return {
    getGuildRoster: (root, signal, onProfileRequest) =>
      scope.time("blizzard", (excluded) =>
        gateway.getGuildRoster(
          root,
          signal,
          excludeObserver(excluded, onProfileRequest)
        )
      ),
    getAchievementFingerprint: (key, signal, onProfileRequest) =>
      scope.time("blizzard", (excluded) =>
        gateway.getAchievementFingerprint(
          key,
          signal,
          excludeObserver(excluded, onProfileRequest)
        )
      ),
    getCompletedAchievements: (key, signal, onProfileRequest) =>
      scope.time("blizzard", (excluded) =>
        gateway.getCompletedAchievements(
          key,
          signal,
          excludeObserver(excluded, onProfileRequest)
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
      | "fingerprint_blizzard_rate_limited";
    details: Record<string, number>;
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
  };
  enqueueFingerprintAdmission?: (runId: string) => Promise<unknown>;
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

  return {
    async execute(
      runId: string,
      workContext?: DiscoveryExecutionContext
    ): Promise<void> {
      // Created before the first query so the run lookup and claim reach
      // `dbCalls` too; nothing else about the run depends on its lifetime.
      // `observedAt` moves up with it so `durationMs` still spans every
      // measured call and the buckets stay within it.
      const observedAt = monotonic();
      const scope = createMeasurementScope(monotonic);
      const repositories = measuredRepositories(options.repositories, scope);

      let context = workContext;
      if (!context) {
        const existing = await repositories.runs.find(runId);
        if (!existing) throw new Error("discovery_run_not_found");
        if (existing.status === "complete" || existing.status === "failed") {
          return;
        }
        context = {
          attempt: existing.attempt + 1,
          maxAttempts,
          signal: new AbortController().signal
        };
      }

      const run = await repositories.runs.claim(runId, context.attempt);
      if (!run) return;

      const startedAt = now();
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
        durationMs: 0,
        correlationId: context.correlationId ?? null,
        queueWaitMs: queueWaitMs(context.enqueuedAt, startedAt),
        fingerprintQueueWaitMs: null,
        fingerprintReservedRequests: 0,
        fingerprintUsedRequests: 0,
        fingerprintDurationMs: 0
      };

      try {
        context.signal.throwIfAborted();
        const executionTime = startedAt;
        if (
          executionTime.getTime() - run.createdAt.getTime() >=
          maxJobLifetimeMs
        ) {
          record.outcome = "lifetime_exceeded";
          await repositories.runs.fail(runId, "upstream_unavailable");
          return;
        }

        let outcome: DiscoveryOutcome = await discoverCharacter(
          run.rootKey,
          scopedRaiderIoGateway(options.gateway, scope),
          {
            requestCap: options.requestCap,
            isSuppressed: (key) => repositories.suppressions.isActive(key),
            signal: context.signal
          }
        );
        context.signal.throwIfAborted();
        const persistenceTime = now();
        if (
          persistenceTime.getTime() - run.createdAt.getTime() >=
          maxJobLifetimeMs
        ) {
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
                at: admissionTime
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
                  scopedBlizzardGateway(blizzardGateway, scope),
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
                    signal: context.signal
                  }
                );

                if (sweep.kind === "failure") {
                  await releaseReservation();
                  fingerprintFailure = sweep;
                } else {
                  context.signal.throwIfAborted();
                  const fingerprintPersistenceTime = now();
                  if (
                    fingerprintPersistenceTime.getTime() -
                      run.createdAt.getTime() >=
                    maxJobLifetimeMs
                  ) {
                    record.outcome = "lifetime_exceeded";
                    await releaseReservation();
                    await repositories.runs.fail(runId, "upstream_unavailable");
                    return;
                  }
                  const limitationCode =
                    sweep.kind === "capped"
                      ? "fingerprint_sweep_capped"
                      : outcome.state === "partial"
                        ? outcome.limitationCode
                        : null;
                  const excludedTournamentCharacters = new Set(
                    outcome.state === "partial"
                      ? outcome.excludedTournamentCharacterIds
                      : []
                  );
                  const characters = deduplicateCharacters([
                    ...outcome.characters,
                    ...sweep.characters
                  ]).filter(
                    (character) =>
                      !excludedTournamentCharacters.has(
                        canonicalCharacterId(character.key)
                      )
                  );
                  record.outcome = "snapshot";
                  record.state =
                    limitationCode === null ? "complete" : "partial";
                  record.limitationCode = limitationCode;
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
                      limitationCode
                    },
                    { resumeAfter: null, limitationCode: null },
                    { signal: context.signal }
                  );
                  reservationActive = false;
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
          if (current.status === "complete") return;
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
      }
    }
  };
}

export type DiscoveryJobHandler = ReturnType<typeof createDiscoveryJobHandler>;
