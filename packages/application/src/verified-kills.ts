import {
  raiderIoRaidContentWindowEnd,
  STORED_KILL_MATCH_MS,
  supportedRegions,
  type CharacterKey
} from "@slashwho/domain";
import {
  raiderIoHistoricTiers,
  type HistoricMythicKill,
  type RaiderIoGateway
} from "@slashwho/raiderio";
import type { WarcraftLogsVerifiedKill } from "@slashwho/warcraftlogs";

export type VerifiedKillsResult = Readonly<{
  kills: readonly WarcraftLogsVerifiedKill[];
  /**
   * Every guild Raider.IO placed a kill in, whether or not that kill is still
   * worth searching for, as places a tier search walks attendance for.
   */
  guilds?: readonly WarcraftLogsVerifiedKill["guild"][];
  /**
   * Why Raider.IO could not answer. The run is not partial for it: recovery
   * is a supplement to the history scan, and a private profile would
   * otherwise retry forever.
   */
  limitation?: string;
  /**
   * Every first kill Raider.IO answered with, before any is filtered as a
   * search hint (#732). Absent when Raider.IO could not answer.
   */
  firstKills?: readonly HistoricMythicKill[];
  /** The raids the asked tiers answer for, and any a kill came back from. */
  askedRaidSlugs?: readonly string[];
}>;

/**
 * The Mythic kills Raider.IO attributes to the character that stored
 * Warcraft Logs evidence does not already hold, as places to search. A plain
 * kill is never evidence: it counts only once a hydrated log attributes it,
 * or once Raider.IO's own logged encounter of it is read (#732). What is
 * already stored is kept by `storedKillReportCodes`, never by this: a
 * Raider.IO failure must not decide what stored evidence survives.
 */
export async function raiderIoVerifiedKills(
  raiderio: Pick<RaiderIoGateway, "getHistoricMythicKills">,
  key: CharacterKey,
  options: Readonly<{
    storedKills: readonly Readonly<{ killedAt: string }>[];
    killScanFloor?: string;
    signal?: AbortSignal;
    onPhysicalRequest?: () => void;
  }>
): Promise<VerifiedKillsResult> {
  const tierOrdinals = historicTierOrdinalsFrom(options.killScanFloor);
  let result: Awaited<ReturnType<RaiderIoGateway["getHistoricMythicKills"]>>;
  try {
    result = await raiderio.getHistoricMythicKills(key, {
      tierOrdinals,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onPhysicalRequest
        ? { onPhysicalRequest: options.onPhysicalRequest }
        : {})
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { kills: [], limitation: "unavailable" };
  }
  if (result.kind === "limitation") {
    return { kills: [], limitation: result.code };
  }
  return {
    kills: searchableKills(result.kills, options),
    guilds: raiderIoGuilds(result.kills),
    firstKills: result.kills,
    askedRaidSlugs: [
      ...new Set([
        ...raiderIoHistoricTiers
          .filter((tier) => tierOrdinals.includes(tier.ordinal))
          .flatMap((tier) => tier.raidSlugs),
        ...result.kills.map((kill) => kill.raidSlug)
      ])
    ].sort()
  };
}

/**
 * The Raider.IO tiers still worth asking, given the character's scan floor.
 *
 * A tier is left out only when every raid it answers for stopped being
 * current content before the floor. Whatever it could return is then either
 * below the floor, which `searchableKills` never searches, or a first kill
 * made after its raid's content window closed, which the dossier does not
 * count as current. Asking for it again on every run was most of a full run's
 * Raider.IO requests and about a quarter of its median time (#298).
 *
 * Kept whenever that cannot be shown: no floor, a floor that cannot be read,
 * or a raid the catalogue cannot place. The last pinned tier is always kept,
 * because current raids ride along on every tier's response and one of them
 * has to be asked for this week's kills to arrive at all.
 */
export function historicTierOrdinalsFrom(
  killScanFloor: string | undefined,
  tiers: readonly Readonly<{
    ordinal: number;
    raidSlugs: readonly string[];
  }>[] = raiderIoHistoricTiers,
  contentWindowEnd: (
    raidSlug: string
  ) => string | null = raiderIoRaidContentWindowEnd
): readonly number[] {
  const floor =
    killScanFloor === undefined ? Number.NaN : Date.parse(killScanFloor);
  const closedBelowFloor = (slug: string) => {
    const endsAt = contentWindowEnd(slug);
    return endsAt !== null && Date.parse(endsAt) < floor;
  };
  return tiers
    .filter(
      (tier, index) =>
        Number.isNaN(floor) ||
        index === tiers.length - 1 ||
        !tier.raidSlugs.every(closedBelowFloor)
    )
    .map((tier) => tier.ordinal);
}

export function raiderIoGuilds(
  kills: readonly HistoricMythicKill[]
): readonly WarcraftLogsVerifiedKill["guild"][] {
  const guilds = new Map<string, WarcraftLogsVerifiedKill["guild"]>();
  for (const { guild } of kills) {
    if (!guild) continue;
    const region = guild.region as CharacterKey["region"];
    if (!supportedRegions.includes(region)) continue;
    guilds.set(`${region}/${guild.realm}/${guild.name}`, {
      name: guild.name,
      realm: guild.realm,
      region
    });
  }
  return [...guilds.values()];
}

export function searchableKills(
  kills: readonly HistoricMythicKill[],
  options: Readonly<{
    storedKills: readonly Readonly<{ killedAt: string }>[];
    killScanFloor?: string;
  }>
): readonly WarcraftLogsVerifiedKill[] {
  const stored = options.storedKills
    .map((kill) => Date.parse(kill.killedAt))
    .filter((at) => !Number.isNaN(at));
  const floor =
    options.killScanFloor === undefined
      ? undefined
      : Date.parse(options.killScanFloor);
  return kills.flatMap((kill) => {
    const guild = kill.guild;
    const at = Date.parse(kill.firstDefeated);
    // A kill with no guild has no attendance to search.
    if (!guild || Number.isNaN(at)) return [];
    const region = guild.region as CharacterKey["region"];
    if (!supportedRegions.includes(region)) return [];
    // Below every terminal tier: settled, and searching for it again on every
    // run is the repeated cost this exists to avoid.
    if (floor !== undefined && !Number.isNaN(floor) && at < floor) return [];
    // Held: the stored kill's own report is re-read instead, so there is
    // nothing to search for.
    if (stored.some((held) => Math.abs(held - at) <= STORED_KILL_MATCH_MS)) {
      return [];
    }
    return [
      {
        at: new Date(at).toISOString(),
        guild: { name: guild.name, realm: guild.realm, region }
      }
    ];
  });
}

/**
 * The reports stored kills -- and wipes -- outside terminal raids came from. A
 * complete publish keeps only what the run finds again there, so these are
 * re-read after a fresh scan that did not reach them -- which is how evidence
 * recovered from guild attendance, absent from the character's own history,
 * survives. A wipe-only night a tier search found (#435) has no kill to carry
 * its report, so wipes are named here too. A report the scan read costs
 * nothing: the gateway skips it.
 */
export function storedKillReportCodes(
  storedKills: readonly Readonly<{ raidId: string; reportUrl?: string }>[],
  terminalKillRaidIds: ReadonlySet<string>
): readonly string[] {
  const codes = new Set<string>();
  for (const kill of storedKills) {
    if (terminalKillRaidIds.has(kill.raidId)) continue;
    const code = kill.reportUrl?.match(
      /\/reports\/([A-Za-z0-9]+)(?:[/?#]|$)/
    )?.[1];
    if (code) codes.add(code);
  }
  return [...codes];
}

/**
 * How long a night searched to the end and found empty is left alone (#434).
 * A kill whose first defeat was never logged would otherwise be searched for
 * on every full run -- Yawnersw spent 39 attendance pages, about 1,090 of a
 * 1,168-point run, finding nothing (2026-09-23). A week, not forever: a log
 * can be uploaded late, and attendance fills in when it is.
 */
export const EMPTY_SEARCH_RECHECK_MS = 7 * 24 * 60 * 60 * 1_000;

/** One verified kill's identity for remembering its search, time normalised. */
export function emptySearchKey(
  search: Readonly<{
    at: string;
    guild: Readonly<{ name: string; realm: string; region: string }>;
  }>
): string {
  return [
    search.guild.region,
    search.guild.realm,
    search.guild.name,
    String(Date.parse(search.at))
  ].join("\0");
}
