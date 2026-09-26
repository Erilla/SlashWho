import type {
  DossierTierSearch,
  DossierTierSearchCharacter
} from "@slashwho/contracts";
import type { LatestTierSearch, StoredEvidenceTiers } from "@slashwho/database";
import {
  canonicalCharacterId,
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

/** One included dossier character, as a tier search reads it. */
export type TierSearchSubject = Readonly<{
  key: CharacterKey;
  displayName: string;
  /** Other names merged into this character by Warcraft Logs ID (#490). */
  aliases?: readonly CharacterKey[];
}>;

function characterState(
  status: LatestTierSearch["status"],
  searchableAgainAt: Date,
  now: Date
): DossierTierSearchCharacter["state"] {
  if (status === "running") return "running";
  if (status === "queued" || status === "retrying") return "queued";
  if (searchableAgainAt <= now) return "not_searched";
  return status === "complete"
    ? "completed"
    : status === "partial"
      ? "partial"
      : "failed";
}

/**
 * The dossier's view of each tier's searches across its included characters
 * (#449). A character's newest search, under any of its merged names, is in
 * flight or ended within the rate limit's window; otherwise the character is
 * still to search, unless `withEvidence` says it has nothing collected for a
 * search to add to (#494 review): a reservation always refuses it, so it is
 * never counted as remaining. `withEvidence` holds canonical character ids;
 * without it every character is taken to be searchable. A tier no character
 * has such a search for is absent, meaning it may be searched.
 */
export function tierSearchStates(
  subjects: readonly TierSearchSubject[],
  latest: readonly LatestTierSearch[],
  now: Date,
  withEvidence?: ReadonlySet<string>
): ReadonlyMap<string, DossierTierSearch> {
  const subjectOf = new Map<string, number>();
  subjects.forEach((subject, index) => {
    for (const key of [subject.key, ...(subject.aliases ?? [])]) {
      subjectOf.set(canonicalCharacterId(key), index);
    }
  });
  // Each tier's newest search per subject: several names of one character
  // may each have searched it.
  const newest = new Map<string, Map<number, LatestTierSearch>>();
  for (const search of latest) {
    const index = subjectOf.get(canonicalCharacterId(search.key));
    if (index === undefined) continue;
    const bySubject = newest.get(search.raidId) ?? new Map();
    const current = bySubject.get(index);
    if (!current || search.createdAt > current.createdAt) {
      bySubject.set(index, search);
    }
    newest.set(search.raidId, bySubject);
  }

  const states = new Map<string, DossierTierSearch>();
  for (const [raidId, bySubject] of newest) {
    const characters: DossierTierSearchCharacter[] = subjects.map(
      (subject, index) => {
        const search = bySubject.get(index);
        const base = { key: subject.key, displayName: subject.displayName };
        const idle =
          withEvidence && !withEvidence.has(canonicalCharacterId(subject.key))
            ? "no_evidence"
            : "not_searched";
        if (!search) return { ...base, state: idle };
        const searchableAgainAt = new Date(
          search.createdAt.getTime() + TIER_SEARCH_SPACING_MS
        );
        const state = characterState(search.status, searchableAgainAt, now);
        return state === "not_searched"
          ? { ...base, state: idle }
          : {
              ...base,
              state,
              searchedAt: search.createdAt.toISOString(),
              searchableAgainAt: searchableAgainAt.toISOString()
            };
      }
    );
    const searched = characters.filter(
      (character) =>
        character.state !== "not_searched" && character.state !== "no_evidence"
    );
    if (searched.length === 0) continue;
    const state = characters.some((character) => character.state === "running")
      ? "running"
      : characters.some((character) => character.state === "queued")
        ? "queued"
        : characters.some((character) => character.state === "not_searched")
          ? "partly_searched"
          : "searched";
    states.set(raidId, {
      state,
      searchedAt: searched
        .map((character) => character.searchedAt!)
        .reduce((left, right) => (left > right ? left : right)),
      searchableAgainAt: searched
        .map((character) => character.searchableAgainAt!)
        .reduce((left, right) => (left < right ? left : right)),
      characters
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
