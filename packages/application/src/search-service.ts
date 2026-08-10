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
  DiscoveryQueue,
  Repositories,
  SearchReservationResult
} from "@slashwho/database";
import {
  parseRaiderIoCharacterUrl,
  toCharacterPath,
  type CharacterKey
} from "@slashwho/domain";

import {
  AuthenticationError,
  classifyCaller,
  type CallerIdentity
} from "./auth";
import type { ApplicationConfig } from "./config";
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
}>;

export type CreateSearchResult =
  | { kind: "character"; character: CharacterResource }
  | {
      kind: "job";
      jobId: string;
      status: "queued" | "running" | "retrying";
      statusUrl: string;
      characterUrl: string;
      staleCharacter: CharacterResource | null;
    }
  | { kind: "not_found"; code: "character_not_found" | "suppressed_character" }
  | { kind: "invalid"; code: "invalid_character_url" }
  | { kind: "unauthorized"; code: "unauthorized" }
  | { kind: "client_ip_unavailable"; code: "trusted_client_ip_unavailable" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "failed"; code: "search_failed" };

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
    staleCharacter: characterResourceSchema.nullable()
  })
  .strict();

export interface SearchService {
  create(input: CreateSearchCommand): Promise<CreateSearchResult>;
  authorizePublicRead(
    headers: Pick<Headers, "get">
  ): Promise<PublicReadAuthorizationResult>;
  getRun(jobId: string): Promise<JobStatusResponse | null>;
  getCurrent(key: CharacterKey): Promise<CharacterResource | null>;
  getHistory(key: CharacterKey, cursor?: string): Promise<HistoryPage | null>;
  getSnapshot(
    key: CharacterKey,
    snapshotId: string
  ): Promise<HistoricalSnapshot | null>;
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
    const queueJobId = await queue.enqueue(payload);
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
  config: ApplicationConfig;
  now?: () => Date;
}): SearchService {
  const now = options.now ?? (() => new Date());
  const rateLimiter = createRateLimiter({
    repository: options.repositories.rateLimits,
    config: options.config,
    now
  });

  async function limitedRead(
    caller: CallerIdentity,
    result: CreateSearchResult
  ): Promise<CreateSearchResult> {
    const decision = await rateLimiter.reservePublicRead(caller);
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
    staleCharacter: CharacterResource | null
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
      characterUrl: toCharacterPath(reservation.run.rootKey)
    });
    if (response.kind !== "job") throw new Error("invalid_job_response");
    return searchJobResultSchema.parse({
      kind: "job",
      jobId: response.jobId,
      status,
      statusUrl: response.statusUrl,
      characterUrl: response.characterUrl,
      staleCharacter
    });
  }

  return {
    async create(input) {
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
      if (await options.repositories.suppressions.isActive(key, at)) {
        return limitedRead(caller, {
          kind: "not_found",
          code: "suppressed_character"
        });
      }

      const current = await options.repositories.snapshots.getCurrent(key);
      if (
        current &&
        current.refreshedAt.getTime() >
          at.getTime() - options.config.FRESHNESS_HOURS * 60 * 60 * 1_000
      ) {
        return limitedRead(caller, {
          kind: "character",
          character: serializeCharacterResource(current)
        });
      }

      if (
        !current &&
        (await options.repositories.negativeCache.find(key, at))
      ) {
        return limitedRead(caller, {
          kind: "not_found",
          code: "character_not_found"
        });
      }

      const searchPolicy = rateLimiter.searchReservation(caller);
      const reservation = await options.repositories.searchReservations.reserve(
        {
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
        }
      );
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
        return limitedRead(caller, {
          kind: "not_found",
          code: "suppressed_character"
        });
      }
      if (reservation.kind === "negative") {
        return limitedRead(caller, {
          kind: "not_found",
          code: "character_not_found"
        });
      }
      if (reservation.kind === "fresh") {
        const fresh = await options.repositories.snapshots.getCurrent(key);
        if (fresh) {
          return limitedRead(caller, {
            kind: "character",
            character: serializeCharacterResource(fresh)
          });
        }
        return limitedRead(caller, {
          kind: "not_found",
          code: (await options.repositories.suppressions.isActive(key, at))
            ? "suppressed_character"
            : "character_not_found"
        });
      }

      const staleCharacter = current
        ? serializeCharacterResource(current, reservation.run)
        : null;
      if (reservation.kind === "active") {
        return jobResult(reservation, staleCharacter);
      }

      let queueJobId: string;
      try {
        queueJobId = await options.queue.enqueue({
          runId: reservation.run.id,
          key
        });
      } catch {
        await options.repositories.searchReservations.cancel(
          reservation.run.id
        );
        return { kind: "failed", code: "search_failed" };
      }
      await options.repositories.searchReservations
        .markEnqueued(reservation.run.id, queueJobId)
        .catch(() => undefined);
      return jobResult(reservation, staleCharacter);
    },

    async authorizePublicRead(headers) {
      let caller: CallerIdentity;
      try {
        caller = classifyCaller(headers, options.config);
      } catch (error) {
        if (error instanceof AuthenticationError) {
          return { allowed: false, code: error.code };
        }
        throw error;
      }
      const decision = await rateLimiter.reservePublicRead(caller);
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

    async cleanupExpired(at = now()) {
      return cleanupExpired(options.repositories, at);
    }
  };
}
