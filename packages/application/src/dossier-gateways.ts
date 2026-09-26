import { lookupCuttingEdgeAchievement } from "@slashwho/domain";
import type { BlizzardGateway } from "@slashwho/blizzard";
import type {
  RaiderIoGateway,
  MythicBossRankingsOptions,
  MythicBossRankingsResult
} from "@slashwho/raiderio";

import { awaitWithAbort } from "./abort";
import { createBoundedCache, type BoundedCacheOutcome } from "./bounded-cache";
import { createConcurrencyLimiter } from "./concurrency";
import type { ApplicationConfig } from "./config";
import { rankingRequestKey } from "./historic-world-rank";
import type { MeasurementScope } from "./measurement";

/** How long one provider call the dossier read makes may take. */
export const PROVIDER_TIMEOUT_MS = 15_000;

/**
 * Visitor-supplied credentials for a single dossier read. Gateways built from
 * these keys are used directly, never through the caches shared by every other
 * visitor, so one visitor's key budget can neither fill nor be billed for
 * another's results.
 */
export type DossierGatewayOverrides = Readonly<{
  blizzard?: Pick<BlizzardGateway, "getCompletedAchievements">;
  raiderio?: Pick<RaiderIoGateway, "getMythicBossRankings" | "getCharacter">;
  wclCredentials?: WclCredentials | null;
  wclCredentialRef?: { accountId: string; credentialVersion: number };
}>;

export type WclCredentials = Readonly<{
  clientId: string;
  clientSecret: string;
}>;

class RankingLookupFailure extends Error {
  constructor(
    readonly result: Extract<MythicBossRankingsResult, { kind: "limitation" }>
  ) {
    super("rankings_unavailable");
  }
}

// Sized for the achievement lookups made by one cold dossier and the number
// of distinct rosters that should fit inside the TTL window without eviction.
const DOSSIER_CACHE_TTL_MS = 15 * 60_000;
// Every included character is read now, not the first 12 (#555); 25 covers
// the largest roster seen (23) rather than the ceiling, which is a backstop.
const ACHIEVEMENT_KEYS_PER_DOSSIER = 25;
// The multiple is the number of concurrent cold reads of distinct rosters that
// fit inside the 15-minute window before entries start evicting each other.
//
// Replicas are not what this covers. Each `web` replica holds its own
// process-local cache, so replication splits traffic across instances rather
// than crowding one -- it costs hit rate, because every replica cold-loads the
// same keys independently, not capacity per instance.
//
// This also sets the cache's in-flight ceiling, since `createBoundedCache`
// rejects a load once `pending.size` reaches `maxEntries`. That is a far
// backstop at these sizes rather than the operative limit: achievement loads
// are admitted by `providerConcurrency` and gathered one character at a time.
// Parallelising that gather (#241) raises the cache's in-flight count per read
// and should re-check this.
const CONCURRENT_COLD_DOSSIERS = 40;

// Maps a bounded cache's per-call outcome onto the requesting scope's own
// counters. Attributed per call (via the cache's optional per-call observer
// parameter), never broadcast to every scope sharing the process-wide cache
// instance -- the same defect already fixed for the concurrency limiter.
const cacheField: Record<string, string> = {
  hit: "cacheHits",
  miss: "cacheMisses",
  shared: "cacheShared",
  failure: "cacheFailures",
  capacity: "cacheCapacity"
};

function cacheObserver(
  scope?: MeasurementScope
): ((event: BoundedCacheOutcome) => void) | undefined {
  if (!scope) return undefined;
  return (event) => {
    scope.increment(cacheField[event] ?? "cacheFailures");
  };
}

/**
 * The provider gateways a dossier read goes through, and the limiter that
 * admits their calls. The caches and the limiter are built once and shared by
 * every read; what each read gets is rebuilt per call, so its time and waits
 * are attributed to that read's own scope.
 */
export function createDossierGateways(options: {
  blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
  raiderio: Pick<RaiderIoGateway, "getMythicBossRankings">;
  config: Pick<
    ApplicationConfig,
    "NEGATIVE_CACHE_TTL_MS" | "DOSSIER_PROVIDER_CONCURRENCY"
  >;
  onCacheEvent?: (source: string, event: string) => void;
}) {
  const achievements = createBoundedCache<
    Awaited<ReturnType<BlizzardGateway["getCompletedAchievements"]>>
  >({
    ttlMs: DOSSIER_CACHE_TTL_MS,
    maxEntries: ACHIEVEMENT_KEYS_PER_DOSSIER * CONCURRENT_COLD_DOSSIERS,
    observe: (event) => options.onCacheEvent?.("blizzard_cutting_edge", event)
  });
  const rankings = createBoundedCache<
    Awaited<ReturnType<RaiderIoGateway["getMythicBossRankings"]>>
  >({
    ttlMs: DOSSIER_CACHE_TTL_MS,
    maxEntries: 25 * CONCURRENT_COLD_DOSSIERS,
    negativeTtlMs: options.config.NEGATIVE_CACHE_TTL_MS,
    cacheFailure: (error) =>
      error instanceof RankingLookupFailure &&
      error.result.code === "unavailable",
    observe: (event) => options.onCacheEvent?.("raiderio_rankings", event)
  });
  // The limiter instance is shared across every request so it actually
  // bounds the fan-out; only the wait *reporting* is per-call, via a
  // scope-bound facade built per readInitial/read call below.
  const providerConcurrency = createConcurrencyLimiter(
    options.config.DOSSIER_PROVIDER_CONCURRENCY
  );
  // A null cache is a visitor-supplied gateway: it keeps the shared timeout,
  // filtering and failure semantics while neither reading from nor writing to
  // the caches every other visitor is served from.
  //
  // `scope` is the caller's own measurement scope, never a stored one: the
  // gateway is rebuilt per read so provider time is attributed to the single
  // request that spent it, whether that request uses the shared gateway or its
  // own credentials.
  function cuttingEdgeGateway(
    source: Pick<BlizzardGateway, "getCompletedAchievements">,
    cache: typeof achievements | null,
    scope?: MeasurementScope
  ): Pick<BlizzardGateway, "getCompletedAchievements"> {
    return {
      async getCompletedAchievements(key, signal) {
        signal?.throwIfAborted();
        const load = async () => {
          const run = async () =>
            source.getCompletedAchievements(
              key,
              AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
            );
          const rows = scope ? await scope.time("blizzard", run) : await run();
          return rows
            .filter(
              (row) => lookupCuttingEdgeAchievement(row.achievementId) !== null
            )
            .map(({ achievementId, completedAt }) => ({
              achievementId,
              completedAt
            }));
        };
        const result = await awaitWithAbort(
          cache
            ? cache(
                `${key.region}/${key.realm}/${key.name}`,
                load,
                cacheObserver(scope)
              )
            : load(),
          signal
        );
        return result;
      }
    };
  }

  // Reports this call's admission wait to its own scope rather than the
  // shared limiter's constructor-level onWait, without cloning the limiter
  // itself: the single shared instance must keep bounding the fan-out.
  function scopedConcurrency(
    scope?: MeasurementScope
  ): Pick<ReturnType<typeof createConcurrencyLimiter>, "run"> {
    if (!scope) return providerConcurrency;
    return {
      run: (work) =>
        providerConcurrency.run(work, (ms) =>
          scope.observe("limiterWaitMs", ms)
        )
    };
  }
  // New ranks are durable worker evidence. A legacy rankless kill gets one
  // successful read fallback, then its answer (including no match) is stored.
  function gatewaysFor(
    overrides?: DossierGatewayOverrides,
    scope?: MeasurementScope
  ) {
    return {
      blizzard: cuttingEdgeGateway(
        overrides?.blizzard ?? options.blizzard,
        overrides?.blizzard ? null : achievements,
        scope
      ),
      raiderio: {
        getMythicBossRankings: async (
          request: MythicBossRankingsOptions,
          signal?: AbortSignal
        ) => {
          signal?.throwIfAborted();
          const load = async (): Promise<MythicBossRankingsResult> => {
            const call = () =>
              overrides?.raiderio
                ? overrides.raiderio.getMythicBossRankings(request, signal)
                : options.raiderio.getMythicBossRankings(
                    request,
                    AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
                    () => scope?.increment("raiderIoRankingPhysicalCalls")
                  );
            const result = scope
              ? await scope.time("raiderIoRankings", call)
              : await call();
            if (result.kind === "limitation") {
              options.onCacheEvent?.(
                "raiderio_rankings",
                `failure_${result.code}`
              );
              throw new RankingLookupFailure({
                ...result,
                observedAt: result.observedAt ?? new Date().toISOString()
              });
            }
            return result;
          };
          try {
            return await awaitWithAbort(
              overrides?.raiderio
                ? load()
                : rankings(
                    rankingRequestKey(request),
                    load,
                    cacheObserver(scope)
                  ),
              signal
            );
          } catch (error) {
            signal?.throwIfAborted();
            return error instanceof RankingLookupFailure
              ? error.result
              : {
                  kind: "limitation" as const,
                  code: "unavailable" as const,
                  observedAt: new Date().toISOString()
                };
          }
        }
      }
    };
  }
  return { gatewaysFor, scopedConcurrency };
}
