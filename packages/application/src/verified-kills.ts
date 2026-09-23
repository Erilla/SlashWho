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
}>;

/**
 * The Mythic kills Raider.IO attributes to the character that stored
 * Warcraft Logs evidence does not already hold, as places to search. Never
 * evidence: a kill counts only once a hydrated log attributes it. What is
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
  return {
    kills: searchableKills(result.kills, options),
    guilds: raiderIoGuilds(result.kills)
  };
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
 * The reports stored kills outside terminal raids came from. A complete
 * publish keeps only what the run finds again there, so these are re-read
 * after a fresh scan that did not reach them -- which is how a kill recovered
 * from guild attendance, absent from the character's own history, survives.
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
