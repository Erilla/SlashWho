import type { DossierTierSearch } from "@slashwho/contracts";
import type { StoredEvidenceTiers } from "@slashwho/database";
import {
  lookupRaidCurrentContentWindow,
  lookupRaidForEvidence,
  type CharacterKey
} from "@slashwho/domain";

/**
 * How long a character's tier stays searched. A search is an explicit, costly
 * request -- about 28 points an attendance page and 6 a hydrated report -- so
 * repeated clicks on one tier are refused rather than re-run (#435). A capped
 * ranked walk resumes through the evidence retry sweep, outside this limit.
 */
export const TIER_SEARCH_SPACING_MS = 24 * 60 * 60 * 1_000;

/**
 * The most requests one tier search may make. Carved out of the run's scan cap
 * by `tierSearchRequestCaps`, never added to it.
 */
export const DEFAULT_TIER_SEARCH_REQUEST_CAP = 60;

export type TierSearchGuild = Readonly<{
  name: string;
  realm: string;
  region: CharacterKey["region"];
}>;

/**
 * The instants a tier search covers: the raid's current-content window, which
 * is also the only span its kills are shown for. A raid still current is
 * searched up to now. Null for a raid the catalogue has no window for, which
 * cannot be searched.
 */
export function tierSearchWindow(
  journalRaidId: string,
  now: Date
): Readonly<{ from: string; to: string }> | null {
  const window = lookupRaidCurrentContentWindow(journalRaidId);
  if (!window) return null;
  const from = Date.parse(window.startsAt);
  const to =
    window.endsAt === null
      ? now.getTime()
      : Math.min(Date.parse(window.endsAt), now.getTime());
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/**
 * The Warcraft Logs zones stored evidence places in a Journal raid. Terminal
 * marks are keyed by zone, so this is what lets a search ignore the tier's
 * marks for its one run. A zone nothing stored names has no mark to ignore.
 */
export function tierSearchZoneIds(
  journalRaidId: string,
  stored: Pick<StoredEvidenceTiers, "kills" | "wipes">
): ReadonlySet<string> {
  const zones = new Set<string>();
  for (const item of [...stored.kills, ...stored.wipes]) {
    const raid = lookupRaidForEvidence({
      raidName: item.raidName,
      bossName: item.bossName ?? "",
      journalBossId: item.journalBossId ?? null
    });
    if (raid?.raidId === journalRaidId) {
      zones.add(item.raidId);
    }
  }
  return zones;
}

/**
 * Below this a run's scan cap is not split. A history cap of one is a light
 * read, which re-reads no stored report, and a complete publish would then
 * drop what attendance recovered earlier: the search would cost evidence.
 */
const MINIMUM_SPLIT_SCAN_CAP = 4;

/**
 * Splits a run's scan cap between its history scan and its tier search. The
 * search takes at most half, so the history scan still advances, and the two
 * together never exceed what `evidenceRunBudget` granted the run.
 */
export function tierSearchRequestCaps(
  scanCap: number,
  configured: number
): Readonly<{ history: number; tier: number }> {
  if (scanCap < MINIMUM_SPLIT_SCAN_CAP) {
    return { history: Math.max(1, scanCap), tier: 0 };
  }
  const tier = Math.max(0, Math.min(configured, Math.floor(scanCap / 2)));
  return { history: scanCap - tier, tier };
}

/**
 * The dossier's view of each tier's newest search: in flight, or searched
 * within the rate limit's window. A tier with neither is absent, meaning it
 * may be searched.
 */
export function tierSearchStates(
  latest: readonly Readonly<{
    raidId: string;
    status: string;
    createdAt: Date;
  }>[],
  now: Date
): ReadonlyMap<string, DossierTierSearch> {
  const states = new Map<string, DossierTierSearch>();
  for (const search of latest) {
    const searchableAgainAt = new Date(
      search.createdAt.getTime() + TIER_SEARCH_SPACING_MS
    );
    const state =
      search.status === "running"
        ? "running"
        : search.status === "queued" || search.status === "retrying"
          ? "queued"
          : searchableAgainAt > now
            ? "searched"
            : null;
    if (state === null) continue;
    states.set(search.raidId, {
      state,
      searchedAt: search.createdAt.toISOString(),
      searchableAgainAt: searchableAgainAt.toISOString()
    });
  }
  return states;
}

/** Every guild known for the character, each once, in the order first seen. */
export function tierSearchGuilds(
  ...sources: readonly (readonly TierSearchGuild[])[]
): readonly TierSearchGuild[] {
  const guilds = new Map<string, TierSearchGuild>();
  for (const guild of sources.flat()) {
    const key = [
      guild.region,
      guild.realm.toLocaleLowerCase("en-US"),
      guild.name.normalize("NFC").toLocaleLowerCase("en-US")
    ].join("/");
    if (!guilds.has(key)) guilds.set(key, guild);
  }
  return [...guilds.values()];
}
