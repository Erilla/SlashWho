import {
  createSearchResponseSchema,
  characterResourceSchema,
  type CharacterResource,
  type HistoricalSnapshot,
  type HistoryPage,
  type JobStatusResponse
} from "@slashwho/contracts";
import { z } from "zod";
import type {
  GroupRead,
  DiscoveryQueue,
  Repositories,
  SearchReservationResult
} from "@slashwho/database";
import { groupMemberFacts } from "@slashwho/domain";
import {
  canonicalCharacterId,
  MAX_CONTINUATION_NON_PROGRESS_CYCLES,
  isFresh,
  isSweepDue,
  parseRaiderIoCharacterUrl,
  toCharacterPath,
  type CharacterKey,
  type RaiderIoCharacter
} from "@slashwho/domain";
import type { RaiderIoGateway } from "@slashwho/raiderio";
import { isUpstreamFailure } from "@slashwho/upstream-http";

import {
  AuthenticationError,
  classifyCaller,
  type CallerIdentity
} from "./auth";
import type { ApplicationConfig } from "./config";
import { measuredRepositories } from "./measured-repositories";
import type { MeasurementScope } from "./measurement";
import { createRateLimiter } from "./rate-limit";
import {
  serializeCharacterResource,
  serializeHistoryPage,
  serializeJobStatus,
  serializeSnapshot
} from "./serializers";

export type CreateSearchCommand = Readonly<{
  characterUrl: string;
  headers: Pick<Headers, "get">;
  correlationId?: string | undefined;
  startedFrom?: "page" | undefined;
}>;

export type CreateSearchResult =
  | { kind: "group_ready"; key: CharacterKey }
  | { kind: "character"; character: CharacterResource }
  | {
      kind: "job";
      jobId: string;
      status: "queued" | "running" | "retrying";
      statusUrl: string;
      characterUrl: string;
      staleCharacter: CharacterResource | null;
      joinedExistingRun: boolean;
      /**
       * The profile this search read, so a caller that must create the
       * character row can reuse it instead of reading Raider.IO again. Internal
       * only: the public response never carries it.
       */
      profile: RaiderIoCharacter;
    }
  | { kind: "not_found"; code: "character_not_found" | "suppressed_character" }
  | { kind: "rejected"; code: "connection_rejected" }
  | { kind: "invalid"; code: "invalid_character_url" }
  | { kind: "unauthorized"; code: "unauthorized" }
  | { kind: "client_ip_unavailable"; code: "trusted_client_ip_unavailable" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | {
      kind: "failed";
      code: "search_failed" | "upstream_unavailable";
    };

export type PublicReadAuthorizationResult =
  | { allowed: true }
  | {
      allowed: false;
      code: "unauthorized" | "trusted_client_ip_unavailable";
    }
  | { allowed: false; retryAfterSeconds: number };

const searchJobResultSchema = z
  .object({
    kind: z.literal("job"),
    jobId: z.uuid(),
    status: z.enum(["queued", "running", "retrying"]),
    statusUrl: z.string().startsWith("/api/v1/searches/"),
    characterUrl: z.string().startsWith("/characters/"),
    staleCharacter: characterResourceSchema.nullable(),
    joinedExistingRun: z.boolean()
  })
  .strict();

export interface SearchService {
  create(
    input: CreateSearchCommand,
    scope?: MeasurementScope
  ): Promise<CreateSearchResult>;
  authorizePublicRead(
    headers: Pick<Headers, "get">,
    scope?: MeasurementScope
  ): Promise<PublicReadAuthorizationResult>;
  /**
   * The per-caller limit on "search this tier" presses, identified the same
   * way a public read is: a hashed bucket, never the raw address.
   */
  authorizeTierSearch(
    headers: Pick<Headers, "get">,
    scope?: MeasurementScope
  ): Promise<PublicReadAuthorizationResult>;
  /** Shared caller allowance for excluding, including and removing connections. */
  authorizeConnectionMutation(
    headers: Pick<Headers, "get">,
    scope?: MeasurementScope
  ): Promise<PublicReadAuthorizationResult>;
  /**
   * Charges one search from the caller's search bucket without starting a
   * search, for work that spends provider budget but is not a discovery run
   * (a refresh, or adding a character whose snapshot is already fresh).
   */
  authorizeSearchAllowance(
    headers: Pick<Headers, "get">,
    scope?: MeasurementScope
  ): Promise<PublicReadAuthorizationResult>;
  getRun(jobId: string): Promise<JobStatusResponse | null>;
  getCurrent(key: CharacterKey): Promise<CharacterResource | null>;
  getHistory(key: CharacterKey, cursor?: string): Promise<HistoryPage | null>;
  getSnapshot(
    key: CharacterKey,
    snapshotId: string
  ): Promise<HistoricalSnapshot | null>;
  /** Queues a bounded connected-character refresh without blocking the dossier. */
  scheduleConnectedCharacterSweep?(
    key: CharacterKey,
    scope?: MeasurementScope,
    groupRead?: GroupRead
  ): Promise<void>;
  cleanupExpired(now?: Date): Promise<CleanupCounts>;
}

export type CleanupCounts = {
  rateLimits: number;
  negativeCache: number;
  suppressions: number;
  fingerprintRequests: number;
};

export async function cleanupExpired(
  repositories: Repositories,
  at: Date = new Date()
): Promise<CleanupCounts> {
  const [rateLimits, negativeCache, suppressions, fingerprintRequests] =
    await Promise.all([
      repositories.rateLimits.cleanupExpired(at),
      repositories.negativeCache.cleanupExpired(at),
      repositories.suppressions.cleanupExpired(at),
      repositories.fingerprintSweeps.cleanupExpired(at)
    ]);
  return { rateLimits, negativeCache, suppressions, fingerprintRequests };
}

export async function recoverPendingSearches(
  repositories: Repositories,
  queue: Pick<DiscoveryQueue, "enqueue">,
  limit = 100
): Promise<number> {
  const pending = await repositories.searchReservations.listPending(limit);
  for (const payload of pending) {
    // A recovered job must measure its new wait, never the original one, so
    // enqueuedAt is stamped fresh at re-enqueue time rather than carried over.
    const queueJobId = await queue.enqueue({
      ...payload,
      enqueuedAt: new Date().toISOString()
    });
    await repositories.searchReservations.markEnqueued(
      payload.runId,
      queueJobId
    );
  }
  return pending.length;
}

function sameKey(left: CharacterKey, right: CharacterKey): boolean {
  return (
    left.region === right.region &&
    left.realm === right.realm &&
    left.name === right.name
  );
}

export function createSearchService(options: {
  repositories: Repositories;
  queue: Pick<DiscoveryQueue, "enqueue">;
  raiderio: Pick<RaiderIoGateway, "getCharacter">;
  config: ApplicationConfig;
  now?: () => Date;
}): SearchService {
  const now = options.now ?? (() => new Date());
  const pendingRootLookups = new Map<string, Promise<RaiderIoCharacter>>();
  const rateLimiter = createRateLimiter({
    repository: options.repositories.rateLimits,
    config: options.config,
    now
  });

  // Admission runs before the route's scoped service call, so its reservation
  // is charged to the request's `db*` totals only when the route passes the
  // scope through. Rebuilt per call for the same reason `create` wraps its
  // repositories per call: the service is a process-wide singleton.
  function admissionLimiter(scope: MeasurementScope | undefined) {
    return scope
      ? createRateLimiter({
          repository: measuredRepositories(options.repositories, scope)
            .rateLimits,
          config: options.config,
          now
        })
      : rateLimiter;
  }

  function readRootCharacter(
    key: CharacterKey,
    scope?: MeasurementScope
  ): Promise<RaiderIoCharacter> {
    const id = canonicalCharacterId(key);
    const pending = pendingRootLookups.get(id);
    if (pending) return pending;
    const lookup = Promise.resolve()
      .then(() =>
        scope
          ? scope.time("raiderIo", () => options.raiderio.getCharacter(key))
          : options.raiderio.getCharacter(key)
      )
      .finally(() => {
        if (pendingRootLookups.get(id) === lookup) {
          pendingRootLookups.delete(id);
        }
      });
    pendingRootLookups.set(id, lookup);
    return lookup;
  }

  async function limitedRead(
    caller: CallerIdentity,
    scope: MeasurementScope | undefined,
    result: CreateSearchResult
  ): Promise<CreateSearchResult> {
    const decision = await admissionLimiter(scope).reservePublicRead(caller);
    return decision.allowed
      ? result
      : {
          kind: "rate_limited",
          retryAfterSeconds: decision.retryAfterSeconds ?? 1
        };
  }

  function jobResult(
    reservation: Extract<
      SearchReservationResult,
      { kind: "active" | "reserved" }
    >,
    staleCharacter: CharacterResource | null,
    openedKey: CharacterKey,
    profile: RaiderIoCharacter
  ): Extract<CreateSearchResult, { kind: "job" }> {
    if (
      reservation.run.status !== "queued" &&
      reservation.run.status !== "running" &&
      reservation.run.status !== "retrying"
    ) {
      throw new Error("active_run_status_invalid");
    }
    const status = reservation.run.status;
    const response = createSearchResponseSchema.parse({
      kind: "job",
      jobId: reservation.run.id,
      status,
      statusUrl: `/api/v1/searches/${reservation.run.id}`,
      characterUrl: toCharacterPath(openedKey)
    });
    if (response.kind !== "job") throw new Error("invalid_job_response");
    const parsed = searchJobResultSchema.parse({
      kind: "job",
      jobId: response.jobId,
      status,
      statusUrl: response.statusUrl,
      characterUrl: response.characterUrl,
      staleCharacter,
      joinedExistingRun: reservation.kind === "active"
    });
    return { ...parsed, profile };
  }

  return {
    async create(input, scope) {
      // Wrapped per call, not at the composition root: this container is a
      // process-wide singleton, so a shared wrapper could not attribute a
      // query to the request that caused it.
      const repositories = scope
        ? measuredRepositories(options.repositories, scope)
        : options.repositories;

      let key: CharacterKey;
      try {
        key = parseRaiderIoCharacterUrl(input.characterUrl);
      } catch {
        return { kind: "invalid", code: "invalid_character_url" };
      }

      let caller: CallerIdentity;
      try {
        caller = classifyCaller(input.headers, options.config);
      } catch (error) {
        if (error instanceof AuthenticationError) {
          return error.code === "unauthorized"
            ? { kind: "unauthorized", code: "unauthorized" }
            : {
                kind: "client_ip_unavailable",
                code: "trusted_client_ip_unavailable"
              };
        }
        throw error;
      }

      const at = now();
      if (await repositories.suppressions.isActive(key, at)) {
        return limitedRead(caller, scope, {
          kind: "not_found",
          code: "suppressed_character"
        });
      }

      const group = await repositories.groupReads?.read(key, at);
      const current = group
        ? group.ownSnapshot
        : await repositories.snapshots.getCurrent(key);
      if (
        group &&
        isFresh(
          groupMemberFacts(group, key).runs.flatMap((run) =>
            run.status === "complete" && run.completedAt
              ? [run.completedAt]
              : []
          ),
          at,
          options.config.FRESHNESS_HOURS
        )
      ) {
        return limitedRead(
          caller,
          scope,
          current
            ? {
                kind: "character",
                character: serializeCharacterResource(current)
              }
            : { kind: "group_ready", key }
        );
      }
      if (
        !repositories.groupReads &&
        current &&
        current.refreshedAt.getTime() >
          at.getTime() - options.config.FRESHNESS_HOURS * 60 * 60 * 1_000
      ) {
        return limitedRead(caller, scope, {
          kind: "character",
          character: serializeCharacterResource(current)
        });
      }

      if (await repositories.negativeCache.find(key, at)) {
        return limitedRead(caller, scope, {
          kind: "not_found",
          code: "character_not_found"
        });
      }

      const searchPolicy = rateLimiter.searchReservation(caller);
      const allowance = await repositories.searchReservations.checkAllowance?.({
        callerBucketHash: searchPolicy.bucketHash,
        limit: searchPolicy.limit,
        at: searchPolicy.at
      });
      if (allowance && !allowance.allowed)
        return {
          kind: "rate_limited",
          retryAfterSeconds:
            rateLimiter.retryDecision(allowance, searchPolicy.at)
              .retryAfterSeconds ?? 1
        };

      let rootProfile: RaiderIoCharacter;
      try {
        rootProfile = await readRootCharacter(key, scope);
      } catch (error) {
        if (isUpstreamFailure(error) && error.kind === "not_found") {
          await repositories.negativeCache.put(
            key,
            new Date(now().getTime() + options.config.NEGATIVE_CACHE_TTL_MS)
          );
          return limitedRead(caller, scope, {
            kind: "not_found",
            code: "character_not_found"
          });
        }
        return limitedRead(caller, scope, {
          kind: "failed",
          code: "upstream_unavailable"
        });
      }

      const reservation = await repositories.searchReservations.reserve({
        key,
        callerClass: caller.callerClass,
        callerBucketHash: searchPolicy.bucketHash,
        limit: searchPolicy.limit,
        expiresAt: searchPolicy.expiresAt,
        at: searchPolicy.at,
        freshnessCutoff: new Date(
          searchPolicy.at.getTime() -
            options.config.FRESHNESS_HOURS * 60 * 60 * 1_000
        )
      });
      if (reservation.kind === "rate_limited") {
        const decision = rateLimiter.retryDecision(
          { allowed: false, retryAt: reservation.retryAt },
          searchPolicy.at
        );
        return {
          kind: "rate_limited",
          retryAfterSeconds: decision.retryAfterSeconds ?? 1
        };
      }

      if (reservation.kind === "suppressed") {
        return limitedRead(caller, scope, {
          kind: "not_found",
          code: "suppressed_character"
        });
      }
      if (reservation.kind === "negative") {
        return limitedRead(caller, scope, {
          kind: "not_found",
          code: "character_not_found"
        });
      }
      if (reservation.kind === "fresh") {
        const fresh = await repositories.snapshots.getCurrent(key);
        if (fresh) {
          return limitedRead(caller, scope, {
            kind: "character",
            character: serializeCharacterResource(fresh)
          });
        }
        if (await repositories.groupReads?.read(key, at))
          return limitedRead(caller, scope, { kind: "group_ready", key });
        return limitedRead(caller, scope, {
          kind: "not_found",
          code: (await repositories.suppressions.isActive(key, at))
            ? "suppressed_character"
            : "character_not_found"
        });
      }
      if (reservation.kind === "not_due")
        return { kind: "failed", code: "search_failed" };

      const staleCharacter = current
        ? serializeCharacterResource(current, reservation.run)
        : null;
      if (reservation.kind === "active") {
        return jobResult(reservation, staleCharacter, key, rootProfile);
      }

      let queueJobId: string;
      try {
        queueJobId = await options.queue.enqueue({
          runId: reservation.run.id,
          key,
          correlationId: input.correlationId,
          enqueuedAt: now().toISOString()
        });
      } catch {
        await repositories.searchReservations.cancel(reservation.run.id);
        return { kind: "failed", code: "search_failed" };
      }
      await repositories.searchReservations
        .markEnqueued(reservation.run.id, queueJobId)
        .catch(() => undefined);
      return jobResult(reservation, staleCharacter, key, rootProfile);
    },

    async authorizePublicRead(headers, scope) {
      let caller: CallerIdentity;
      try {
        caller = classifyCaller(headers, options.config);
      } catch (error) {
        if (error instanceof AuthenticationError) {
          return { allowed: false, code: error.code };
        }
        throw error;
      }
      const decision = await admissionLimiter(scope).reservePublicRead(caller);
      return decision.allowed
        ? { allowed: true }
        : {
            allowed: false,
            retryAfterSeconds: decision.retryAfterSeconds ?? 1
          };
    },

    async authorizeTierSearch(headers, scope) {
      let caller: CallerIdentity;
      try {
        caller = classifyCaller(headers, options.config);
      } catch (error) {
        if (error instanceof AuthenticationError) {
          return { allowed: false, code: error.code };
        }
        throw error;
      }
      const decision = await admissionLimiter(scope).reserveTierSearch(caller);
      return decision.allowed
        ? { allowed: true }
        : {
            allowed: false,
            retryAfterSeconds: decision.retryAfterSeconds ?? 1
          };
    },

    async authorizeSearchAllowance(headers, scope) {
      let caller: CallerIdentity;
      try {
        caller = classifyCaller(headers, options.config);
      } catch (error) {
        if (error instanceof AuthenticationError) {
          return { allowed: false, code: error.code };
        }
        throw error;
      }
      const decision = await admissionLimiter(scope).reserveSearch(caller);
      return decision.allowed
        ? { allowed: true }
        : {
            allowed: false,
            retryAfterSeconds: decision.retryAfterSeconds ?? 1
          };
    },

    async authorizeConnectionMutation(headers, scope) {
      let caller: CallerIdentity;
      try {
        caller = classifyCaller(headers, options.config);
      } catch (error) {
        if (error instanceof AuthenticationError) {
          return { allowed: false, code: error.code };
        }
        throw error;
      }
      const decision =
        await admissionLimiter(scope).reserveConnectionMutation(caller);
      return decision.allowed
        ? { allowed: true }
        : {
            allowed: false,
            retryAfterSeconds: decision.retryAfterSeconds ?? 1
          };
    },

    async getRun(jobId) {
      const run = await options.repositories.runs.find(jobId);
      if (
        !run ||
        (await options.repositories.suppressions.isActive(run.rootKey, now()))
      ) {
        return null;
      }
      return serializeJobStatus(run);
    },

    async getCurrent(key) {
      const snapshot = await options.repositories.snapshots.getCurrent(key);
      if (!snapshot) return null;
      const activeRun = await options.repositories.runs.findActive(key);
      return serializeCharacterResource(snapshot, activeRun);
    },

    async getHistory(key, cursor) {
      if (!(await options.repositories.snapshots.getCurrent(key))) return null;
      return serializeHistoryPage(
        key,
        await options.repositories.snapshots.listHistory(key, {
          cursor: cursor ?? null,
          limit: 20
        })
      );
    },

    async getSnapshot(key, snapshotId) {
      const snapshot = await options.repositories.snapshots.find(snapshotId);
      return snapshot && sameKey(snapshot.rootKey, key)
        ? serializeSnapshot(snapshot)
        : null;
    },

    async scheduleConnectedCharacterSweep(key, scope, groupRead) {
      const repositories = scope
        ? measuredRepositories(options.repositories, scope)
        : options.repositories;
      const sweeps = repositories.fingerprintSweeps;
      const at = now();
      const cadenceCutoff = new Date(
        at.getTime() -
          options.config.FINGERPRINT_SWEEP_CADENCE_HOURS * 3_600_000
      );
      if (repositories.groupReads) {
        const group =
          groupRead ?? (await repositories.groupReads.read(key, at));
        if (!group) return;
        const facts = groupMemberFacts(group, key);
        if (
          !isSweepDue(
            facts.sweepStates,
            facts.runs,
            cadenceCutoff,
            MAX_CONTINUATION_NON_PROGRESS_CYCLES
          )
        )
          return;
        const reservation = await repositories.searchReservations.reserve({
          key,
          callerClass: "anonymous",
          callerBucketHash: "fingerprint-sweep-visit",
          limit: 1_000_000,
          expiresAt: new Date(at.getTime() + 3_600_000),
          at,
          freshnessCutoff: at,
          ignoreFreshness: true,
          sweepDue: {
            cadenceCutoff,
            maxFailures: MAX_CONTINUATION_NON_PROGRESS_CYCLES
          }
        });
        if (reservation.kind !== "reserved") return;
        const queueJobId = await options.queue.enqueue({
          runId: reservation.run.id,
          key: reservation.run.rootKey,
          enqueuedAt: at.toISOString()
        });
        await repositories.searchReservations.markEnqueued(
          reservation.run.id,
          queueJobId
        );
        return;
      }
      if (!sweeps.isDueForVisit) return;
      const due = await sweeps.isDueForVisit(
        key,
        new Date(
          at.getTime() -
            options.config.FINGERPRINT_SWEEP_CADENCE_HOURS * 60 * 60 * 1_000
        )
      );
      if (!due) return;
      const run = await repositories.runs.createOrReuse(key, "anonymous");
      await options.queue.enqueue({
        runId: run.id,
        key,
        enqueuedAt: at.toISOString()
      });
    },

    async cleanupExpired(at = now()) {
      return cleanupExpired(options.repositories, at);
    }
  };
}
