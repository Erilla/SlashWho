import { supportedRegions, type CharacterKey } from "@slashwho/domain";
import {
  raiderIoHistoricTierOrdinals,
  type HistoricMythicKill,
  type RaiderIoGateway
} from "@slashwho/raiderio";
import type { WarcraftLogsVerifiedKill } from "@slashwho/warcraftlogs";

/**
 * How far a stored Warcraft Logs kill may sit from Raider.IO's first-defeated
 * time and still account for it. Wider than the minutes the two usually
 * differ by, because Raider.IO can be a whole hour off: it dates Ryun's Queen
 * Azshara 19:34Z against the log's 20:34Z (1 of 36 matched pairs, measured
 * 2026-09-23). Still inside one raid night, where the stored kill means that
 * night's log was already found.
 */
const STORED_KILL_MATCH_MS = 2 * 60 * 60 * 1_000;

export type VerifiedKillsResult = Readonly<{
  kills: readonly WarcraftLogsVerifiedKill[];
  /**
   * Why Raider.IO could not answer. The run is not partial for it: recovery
   * is a supplement to the history scan, and a private profile would
   * otherwise retry forever.
   */
  limitation?: string;
}>;

/**
 * The Mythic kills Raider.IO attributes to the character that stored
 * Warcraft Logs evidence does not already hold, as places to search. Never
 * evidence: a kill counts only once a hydrated log attributes it.
 */
export async function raiderIoVerifiedKills(
  raiderio: Pick<RaiderIoGateway, "getHistoricMythicKills">,
  key: CharacterKey,
  options: Readonly<{
    storedKills: readonly StoredKillForMatch[];
    terminalKillRaidIds?: ReadonlySet<string>;
    killScanFloor?: string;
    signal?: AbortSignal;
  }>
): Promise<VerifiedKillsResult> {
  let result: Awaited<ReturnType<RaiderIoGateway["getHistoricMythicKills"]>>;
  try {
    result = await raiderio.getHistoricMythicKills(key, {
      tierOrdinals: raiderIoHistoricTierOrdinals,
      ...(options.signal ? { signal: options.signal } : {})
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { kills: [], limitation: "unavailable" };
  }
  if (result.kind === "limitation") {
    return { kills: [], limitation: result.code };
  }
  return { kills: searchableKills(result.kills, options) };
}

export type StoredKillForMatch = Readonly<{
  killedAt: string;
  raidId?: string;
  reportUrl?: string;
}>;

/**
 * What the scan should do about each verified kill: nothing, re-read the
 * report it is already stored from, or search the guild's attendance for it.
 */
export function searchableKills(
  kills: readonly HistoricMythicKill[],
  options: Readonly<{
    storedKills: readonly StoredKillForMatch[];
    /** Raids whose kills a complete publish carries forward unread. */
    terminalKillRaidIds?: ReadonlySet<string>;
    killScanFloor?: string;
  }>
): readonly WarcraftLogsVerifiedKill[] {
  const stored = options.storedKills.flatMap((kill) => {
    const at = Date.parse(kill.killedAt);
    return Number.isNaN(at) ? [] : [{ ...kill, at }];
  });
  const floor =
    options.killScanFloor === undefined
      ? undefined
      : Date.parse(options.killScanFloor);
  return kills.flatMap((kill): WarcraftLogsVerifiedKill[] => {
    const at = Date.parse(kill.firstDefeated);
    if (Number.isNaN(at)) return [];
    // Below every terminal tier: settled, and searching for it again on every
    // run is the repeated cost this exists to avoid.
    if (floor !== undefined && !Number.isNaN(floor) && at < floor) return [];
    const held = stored.find(
      (candidate) => Math.abs(candidate.at - at) <= STORED_KILL_MATCH_MS
    );
    const guild = searchableGuild(kill.guild);
    if (held) {
      // A complete publish carries a terminal raid's kills forward unread.
      if (
        held.raidId !== undefined &&
        options.terminalKillRaidIds?.has(held.raidId)
      ) {
        return [];
      }
      // Anywhere else a complete publish keeps only what the run finds
      // again, and a kill recovered from attendance is not in the
      // character's own history to be found. Its report is re-read directly.
      const knownReportCode = reportCodeOf(held.reportUrl);
      if (knownReportCode !== null) {
        return [{ at: new Date(at).toISOString(), guild, knownReportCode }];
      }
    }
    // A kill with no guild has no attendance to search.
    if (guild === null) return [];
    return [{ at: new Date(at).toISOString(), guild }];
  });
}

function searchableGuild(
  guild: HistoricMythicKill["guild"]
): WarcraftLogsVerifiedKill["guild"] {
  if (!guild) return null;
  const region = guild.region as CharacterKey["region"];
  return supportedRegions.includes(region)
    ? { name: guild.name, realm: guild.realm, region }
    : null;
}

function reportCodeOf(reportUrl: string | undefined): string | null {
  const code = reportUrl?.match(/\/reports\/([A-Za-z0-9]+)(?:[/?#]|$)/)?.[1];
  return code ?? null;
}
