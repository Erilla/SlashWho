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
    storedKills: readonly Readonly<{ killedAt: string }>[];
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
