import type { Repositories } from "@slashwho/database";
import {
  summarizeLimitationEncounters,
  type DossierKillEvidence,
  type DossierLimitation
} from "@slashwho/domain";
import type { RaiderIoGateway } from "@slashwho/raiderio";

import { isAbort } from "./abort";
import type { createConcurrencyLimiter } from "./concurrency";
import {
  historicWorldRankForKill,
  raiderIoRankingRequest,
  rankingRequestKey
} from "./historic-world-rank";

const MAX_LEGACY_RANK_FALLBACK_REQUESTS_PER_READ = 50;

export type StoredRankKillEvidence = DossierKillEvidence &
  Readonly<{
    rankLookup: { killId: string; checkedAt: string | null };
  }>;

export async function restoreMissingHistoricRanks(options: {
  kills: readonly StoredRankKillEvidence[];
  raiderio: Pick<RaiderIoGateway, "getMythicBossRankings">;
  recordLookup: Repositories["evidence"]["recordHistoricRankLookup"];
  concurrency: ReturnType<typeof createConcurrencyLimiter>;
  signal: AbortSignal;
}): Promise<{
  kills: readonly StoredRankKillEvidence[];
  limitations: DossierLimitation[];
}> {
  const requests = new Map<
    string,
    NonNullable<ReturnType<typeof raiderIoRankingRequest>>
  >();
  const cappedKeys = new Set<string>();
  for (const kill of options.kills) {
    if (kill.historicWorldRank !== null || kill.rankLookup.checkedAt) continue;
    const request = raiderIoRankingRequest(kill, kill.character.region);
    if (!request) continue;
    const key = rankingRequestKey(request);
    if (requests.has(key) || cappedKeys.has(key)) continue;
    if (requests.size >= MAX_LEGACY_RANK_FALLBACK_REQUESTS_PER_READ) {
      cappedKeys.add(key);
      continue;
    }
    requests.set(key, request);
  }
  // The kills a set of lookups left unranked, so a limitation can name them.
  const unrankedKills = (matches: (key: string) => boolean) =>
    summarizeLimitationEncounters(
      options.kills.filter((kill) => {
        if (kill.historicWorldRank !== null || kill.rankLookup.checkedAt)
          return false;
        const request = raiderIoRankingRequest(kill, kill.character.region);
        return request !== null && matches(rankingRequestKey(request));
      })
    );
  const rankings = new Map<
    string,
    Awaited<ReturnType<RaiderIoGateway["getMythicBossRankings"]>>
  >();
  await Promise.all(
    [...requests].map(async ([key, request]) => {
      const result = await options.concurrency
        .run(() =>
          options.raiderio.getMythicBossRankings(request, options.signal)
        )
        .catch((error: unknown) => {
          if (isAbort(error, options.signal)) throw error;
          return { kind: "limitation" as const, code: "unavailable" as const };
        });
      rankings.set(key, result);
    })
  );
  const limitations: DossierLimitation[] = [];
  if (cappedKeys.size > 0) {
    limitations.push({
      source: "raiderio",
      character: null,
      code: "request_cap",
      observedAt: new Date().toISOString(),
      encounters: unrankedKills((key) => cappedKeys.has(key))
    });
  }
  for (const result of rankings.values()) {
    if (result.kind === "rankings") continue;
    if (limitations.some((item) => item.code === result.code)) continue;
    const encounters = unrankedKills((key) => {
      const other = rankings.get(key);
      return other?.kind === "limitation" && other.code === result.code;
    });
    limitations.push({
      source: "raiderio",
      character: null,
      code: result.code,
      ...(encounters.length > 0 ? { encounters } : {}),
      observedAt: result.observedAt ?? new Date().toISOString(),
      ...(result.retryAfterMs === undefined
        ? {}
        : {
            retryAt: new Date(
              Date.parse(result.observedAt ?? new Date().toISOString()) +
                Math.max(0, result.retryAfterMs)
            ).toISOString()
          })
    });
  }
  const checkedAt = new Date();
  await Promise.all(
    options.kills.map(async (kill) => {
      if (kill.historicWorldRank !== null || kill.rankLookup.checkedAt) return;
      const request = raiderIoRankingRequest(kill, kill.character.region);
      const result = request
        ? rankings.get(rankingRequestKey(request))
        : undefined;
      if (result?.kind !== "rankings") return;
      const rank = historicWorldRankForKill(
        kill,
        kill.character.region,
        result.rows
      );
      // The dossier remains readable if a legacy write-through fails. The
      // fallback will retry on a later read instead of claiming it was stored.
      await options
        .recordLookup(kill.rankLookup.killId, rank, checkedAt)
        .catch(() => undefined);
    })
  );
  return {
    kills: options.kills.map((kill) => {
      if (kill.historicWorldRank !== null || kill.rankLookup.checkedAt)
        return kill;
      const request = raiderIoRankingRequest(kill, kill.character.region);
      const result = request
        ? rankings.get(rankingRequestKey(request))
        : undefined;
      return result?.kind === "rankings"
        ? {
            ...kill,
            historicWorldRank: historicWorldRankForKill(
              kill,
              kill.character.region,
              result.rows
            )
          }
        : kill;
    }),
    limitations
  };
}
