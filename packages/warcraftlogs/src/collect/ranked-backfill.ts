import type { CharacterKey } from "@slashwho/domain";

import { isLimitation, validCharacterKey, record } from "../decode/primitives";
import {
  decodedRankedKills,
  rankedCharacterName,
  historicEncounterIds,
  historicReportRefs,
  historicZoneIds
} from "../decode/ranked-backfill";
import {
  characterLookup,
  characterVariables,
  historicEncounterRankingsQuery,
  historicRankedReportQuery,
  historicRaidZonesQuery,
  historicZoneRankingsQuery
} from "../queries";
import type { GraphqlResult } from "../transport";
import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsLimitation,
  WarcraftLogsQueryType,
  WarcraftLogsRankedBackfillCursor,
  WarcraftLogsRankedBackfillResult
} from "../types";
import {
  observedRequest,
  type ClientContext,
  type RankedKillOptions
} from "./context";

// How long the zone catalogue is reused; it changes only with a new raid.
const SHARED_ZONES_TTL_MS = 6 * 60 * 60_000;

// Reports that rank nobody, read without proving any, before the walk stops
// reading reports while it has accepted no kill (#742).
const UNPROVABLE_READS = 3;

/**
 * Walks a character's historical Mythic rankings in one raid to the reports
 * behind them, hydrating each ranked fight. Resumable: a capped walk returns
 * the cursor to continue from.
 */
export async function getRankedKillReports(
  ctx: ClientContext,
  requestedKey: CharacterKey,
  options: RankedKillOptions
): Promise<WarcraftLogsRankedBackfillResult> {
  const key = validCharacterKey(requestedKey);
  // Names the read a limitation stopped. A decoder check fails on a request
  // that succeeded, so `onRequest` alone never attributes schema drift.
  const noteLimitation = (
    query: WarcraftLogsQueryType,
    limitation: WarcraftLogsLimitation
  ): WarcraftLogsLimitation => {
    try {
      options.onLimitation?.(query, limitation.code);
    } catch {
      /* Observation never changes evidence. */
    }
    return limitation;
  };
  if (!Number.isSafeInteger(options.requestCap) || options.requestCap < 0) {
    return noteLimitation("zone_rankings", {
      kind: "limitation",
      code: "request_cap"
    });
  }
  if (
    options.cursor &&
    options.cursor.journalRaidId !== options.journalRaidId
  ) {
    return noteLimitation("zone_rankings", {
      kind: "limitation",
      code: "schema_drift"
    });
  }
  const lookup = characterLookup(key, options.characterId);
  let spent = 0;
  const kills = new Map<string, WarcraftLogsFirstKillEvidence>();
  let progress: WarcraftLogsRankedBackfillCursor = options.cursor ?? {
    journalRaidId: options.journalRaidId,
    ...(options.characterId ? { characterId: options.characterId } : {}),
    zoneIds: [],
    zonesLoaded: false,
    zoneIndex: 0,
    encounterIds: [],
    encountersLoaded: false,
    encounterIndex: 0,
    metricIndex: 0,
    reportIndex: 0
  };
  // A cursor saved by the first ranked backfill named zones but not their
  // partitions. Restart discovery so it cannot silently skip older ranks.
  if (progress.zonesLoaded && !progress.partitionIds) {
    progress = {
      ...progress,
      zoneIds: [],
      zonesLoaded: false,
      zoneIndex: 0,
      encounterIds: [],
      encountersLoaded: false,
      encounterIndex: 0,
      metricIndex: 0,
      reportIndex: 0
    };
  }
  const acceptedFights = new Set(progress.acceptedFightKeys ?? []);
  // The names the character was ranked under in the reports accepted here.
  const rankedNames = new Map<
    string,
    Readonly<{ name: string; realm: string }>
  >();
  const names = () =>
    rankedNames.size > 0 ? { rankedNames: [...rankedNames.values()] } : {};
  // What proves a report that ranks nobody: a name the character is known by
  // on its ranked fight (#742).
  const knownNames = () => [
    { name: key.name, realm: key.realm },
    ...(options.formerNames ?? []),
    ...rankedNames.values()
  ];
  // Reads of reports that rank nobody and credited nothing. A tier whose logs
  // predate `rankedCharacters` and hold no known name can prove none of its
  // reports: Tomb of Sargeras read 48 for nothing, about 100 points a press.
  // So once a few have shown that, while the walk has accepted no kill and
  // read no report that ranks anyone, its remaining reports go unread
  // (#742). A tier that has shown one `rankedCharacters` is read whole.
  let unprovableReads = 0;
  let rankingReports = false;
  const limited = (
    query: WarcraftLogsQueryType,
    limitation: WarcraftLogsLimitation
  ): WarcraftLogsRankedBackfillResult => ({
    kind: "evidence",
    kills: [...kills.values()],
    ...names(),
    cursor: { ...progress, acceptedFightKeys: [...acceptedFights] },
    limitation: noteLimitation(query, limitation)
  });
  const request = async (
    category: WarcraftLogsQueryType,
    query: string,
    variables: Record<string, string | number>
  ): Promise<GraphqlResult | null> => {
    if (spent >= options.requestCap) return null;
    spent += 1;
    return observedRequest(ctx.monotonic, options.onRequest, category, () =>
      ctx.graphql(query, variables, options.signal)
    );
  };
  if (!progress.zonesLoaded) {
    const shared = ctx.caches.zones;
    const zones =
      shared && ctx.monotonic() - shared.at < SHARED_ZONES_TTL_MS
        ? { kind: "success" as const, value: shared.value }
        : await request("zone_rankings", historicRaidZonesQuery, {});
    if (!zones)
      return limited("zone_rankings", {
        kind: "limitation",
        code: "request_cap"
      });
    if (zones.kind !== "success") return limited("zone_rankings", zones);
    const scopes = historicZoneIds(zones.value, options.journalRaidId);
    if (!scopes)
      return limited("zone_rankings", {
        kind: "limitation",
        code: "schema_drift"
      });
    // Kept only once it has decoded, so a drifted answer is asked again.
    if (shared?.value !== zones.value) {
      ctx.caches.zones = { value: zones.value, at: ctx.monotonic() };
    }
    progress = { ...progress, ...scopes, zonesLoaded: true };
  }
  while (progress.zoneIndex < progress.zoneIds.length) {
    const zoneId = progress.zoneIds[progress.zoneIndex]!;
    // One read covers every kill of the zone's ranked encounters in a
    // report, so a report is read at most once a zone. Per zone, because a
    // zone walked again under another partition ranks other encounters.
    // Each read report's Mythic kill fights, or "gone" for one Warcraft
    // Logs no longer serves. A report that ranks nobody and that no ranked
    // fight has proved yet keeps its answer: another boss's ranking of it may
    // prove what the first did not, and must not depend on which came first.
    const readReports = new Map<
      string,
      Readonly<{ fights: ReadonlySet<number>; unproved?: unknown }> | "gone"
    >();
    const partition = progress.partitionIds?.[progress.zoneIndex];
    if (partition === undefined)
      return limited("zone_rankings", {
        kind: "limitation",
        code: "schema_drift"
      });
    if (!progress.encountersLoaded) {
      const ranking = await request(
        "zone_rankings",
        historicZoneRankingsQuery(lookup),
        {
          ...characterVariables(lookup),
          zoneId,
          partition
        }
      );
      if (!ranking)
        return limited("zone_rankings", {
          kind: "limitation",
          code: "request_cap"
        });
      if (ranking.kind !== "success") return limited("zone_rankings", ranking);
      const found = historicEncounterIds(ranking.value, options.characterId);
      if (!found)
        return limited("zone_rankings", {
          kind: "limitation",
          code: "schema_drift"
        });
      const only = progress.zoneEncounterIds?.[progress.zoneIndex] ?? null;
      progress = {
        ...progress,
        characterId: found.id,
        encounterIds: only
          ? found.encounters.filter((id) => only.includes(id))
          : found.encounters,
        encountersLoaded: true
      };
    }
    while (progress.encounterIndex < progress.encounterIds.length) {
      const encounterId = progress.encounterIds[progress.encounterIndex]!;
      for (
        ;
        progress.metricIndex < 2;
        progress = {
          ...progress,
          metricIndex: progress.metricIndex + 1,
          reportIndex: 0
        }
      ) {
        const metric = progress.metricIndex === 0 ? "hps" : "dps";
        const ranking = await request(
          "zone_rankings",
          historicEncounterRankingsQuery(metric),
          {
            characterId: progress.characterId!,
            encounterId,
            partition
          }
        );
        if (!ranking)
          return limited("zone_rankings", {
            kind: "limitation",
            code: "request_cap"
          });
        if (ranking.kind !== "success")
          return limited("zone_rankings", ranking);
        const refs = historicReportRefs(ranking.value);
        if (!refs)
          return limited("zone_rankings", {
            kind: "limitation",
            code: "schema_drift"
          });
        for (
          ;
          progress.reportIndex < refs.length;
          progress = { ...progress, reportIndex: progress.reportIndex + 1 }
        ) {
          const ref = refs[progress.reportIndex]!;
          const fightKey = `${ref.code}:${ref.fightId}`;
          if (acceptedFights.has(fightKey)) continue;
          const decode = (value: unknown) =>
            decodedRankedKills(value, {
              code: ref.code,
              ranked: ref,
              zoneId,
              encounterIds: progress.encounterIds,
              characterId: progress.characterId!,
              journalRaidId: options.journalRaidId,
              region: key.region,
              knownNames: knownNames()
            });
          const accept = (
            decoded: readonly WarcraftLogsFirstKillEvidence[]
          ) => {
            for (const kill of decoded) {
              acceptedFights.add(`${kill.reportCode}:${kill.fightId}`);
              kills.set(kill.fightUrl, kill);
            }
          };
          const read = readReports.get(ref.code);
          if (read !== undefined) {
            if (read === "gone") continue;
            // The ranking names a Mythic kill of a report whose kills were
            // read without it: not the report the ranking described.
            if (!read.fights.has(ref.fightId)) {
              return limited("report_hydration", {
                kind: "limitation",
                code: "schema_drift"
              });
            }
            if (read.unproved === undefined) continue;
            const decoded = decode(read.unproved);
            if (isLimitation(decoded))
              return limited("report_hydration", decoded);
            if (decoded.length > 0) {
              readReports.set(ref.code, { fights: read.fights });
              accept(decoded);
            }
            continue;
          }
          if (
            unprovableReads >= UNPROVABLE_READS &&
            !rankingReports &&
            acceptedFights.size === 0
          )
            continue;
          const detail = await request(
            "report_hydration",
            historicRankedReportQuery,
            { code: ref.code }
          );
          if (!detail)
            return limited("report_hydration", {
              kind: "limitation",
              code: "request_cap"
            });
          if (detail.kind !== "success") {
            if (detail.code === "not_found" || detail.code === "private") {
              readReports.set(ref.code, "gone");
              continue;
            }
            return limited("report_hydration", detail);
          }
          const decoded = decode(detail.value);
          if (isLimitation(decoded))
            return limited("report_hydration", decoded);
          if (decoded.length > 0) {
            const ranked = rankedCharacterName(
              detail.value,
              progress.characterId!
            );
            if (ranked) {
              rankedNames.set(
                `${ranked.realm}\0${ranked.name.normalize("NFC").toLocaleLowerCase("en-US")}`,
                ranked
              );
            }
          }
          // Everything the decoder judges -- zone, identity, and every kill
          // of the zone's ranked encounters -- is the report's, not the
          // ranked fight's, so no later ranking of the report can change the
          // answer (#712). Except where identity is the ranked fight's: a
          // report that ranks nobody (#742).
          const entry = record(
            record(record(record(detail.value)?.data)?.reportData)?.report
          );
          const readFights = entry?.fights;
          const ranksNobody = entry?.rankedCharacters === null;
          if (ranksNobody && decoded.length === 0) unprovableReads += 1;
          if (Array.isArray(entry?.rankedCharacters)) rankingReports = true;
          readReports.set(ref.code, {
            fights: new Set(
              (Array.isArray(readFights) ? readFights : []).flatMap(
                (fight: unknown) => {
                  const id = record(fight)?.id;
                  return typeof id === "number" ? [id] : [];
                }
              )
            ),
            ...(ranksNobody && decoded.length === 0
              ? { unproved: detail.value }
              : {})
          });
          accept(decoded);
        }
      }
      progress = {
        ...progress,
        encounterIndex: progress.encounterIndex + 1,
        metricIndex: 0,
        reportIndex: 0
      };
    }
    progress = {
      ...progress,
      zoneIndex: progress.zoneIndex + 1,
      encounterIds: [],
      encountersLoaded: false,
      encounterIndex: 0,
      metricIndex: 0,
      reportIndex: 0
    };
  }
  return { kind: "evidence", kills: [...kills.values()], ...names() };
}
