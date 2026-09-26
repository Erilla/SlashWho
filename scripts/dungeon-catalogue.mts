import { nonEmptyString, positiveInteger, record } from "./lib/json.mts";

/**
 * The Journal's dungeon instances, by name.
 *
 * Warcraft Logs reports a Mythic dungeon boss at the same difficulty as a
 * Mythic raid boss, so difficulty alone cannot tell the history scan which
 * fights are raid evidence. This catalogue is the positive half of that
 * judgement: a zone named here is a dungeon and is not raid evidence, and a
 * zone in neither catalogue is still unplaceable and still treated as evidence
 * going missing.
 *
 * Only names and ids are collected. Nothing downstream shows a dungeon, so
 * there is no artwork or encounter list to gather, and the expansion index
 * already names every dungeon -- one request per expansion rather than one per
 * instance.
 */

export type GeneratedJournalDungeon = Readonly<{
  journalDungeonId: string;
  dungeonName: string;
}>;

export type FetchJournalDungeonsOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  accessToken: string;
  baseUrl: URL;
  region?: string;
  locale?: string;
}>;

export function normalizeJournalDungeon(
  value: unknown
): GeneratedJournalDungeon | null {
  const dungeon = record(value);
  const journalDungeonId = dungeon && positiveInteger(dungeon.id);
  const dungeonName = dungeon && nonEmptyString(dungeon.name);
  return journalDungeonId && dungeonName
    ? { journalDungeonId: String(journalDungeonId), dungeonName }
    : null;
}

function href(value: unknown, baseUrl: URL): URL | null {
  const entry = record(value);
  const key = entry && record(entry.key);
  const valueHref = key && nonEmptyString(key.href);
  if (!valueHref) return null;
  try {
    const url = new URL(valueHref, baseUrl);
    return url.origin === baseUrl.origin ? url : null;
  } catch {
    return null;
  }
}

async function jsonRequest(
  options: FetchJournalDungeonsOptions,
  url: URL
): Promise<Record<string, unknown>> {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("namespace", `static-${options.region ?? "eu"}`);
  requestUrl.searchParams.set("locale", options.locale ?? "en_GB");
  const response = await options.fetch(requestUrl, {
    headers: { Authorization: `Bearer ${options.accessToken}` }
  });
  if (!response.ok)
    throw new Error(`journal_request_failed_${response.status}`);
  const body = record(await response.json());
  if (!body) throw new Error("journal_response_invalid");
  return body;
}

export async function fetchJournalDungeons(
  options: FetchJournalDungeonsOptions
): Promise<readonly GeneratedJournalDungeon[]> {
  const index = await jsonRequest(
    options,
    new URL("/data/wow/journal-expansion/index", options.baseUrl)
  );
  if (!Array.isArray(index.tiers)) throw new Error("journal_tiers_invalid");

  const dungeons = new Map<string, GeneratedJournalDungeon>();
  for (const tier of index.tiers) {
    const tierUrl = href(tier, options.baseUrl);
    if (!tierUrl) throw new Error("journal_tier_href_invalid");
    const tierBody = await jsonRequest(options, tierUrl);
    // An expansion with no dungeons is a data error, not an empty expansion:
    // every tier the Journal serves lists the key, even when it lists nothing
    // under it.
    if (!Array.isArray(tierBody.dungeons))
      throw new Error("journal_dungeons_invalid");
    for (const value of tierBody.dungeons) {
      const dungeon = normalizeJournalDungeon(value);
      if (!dungeon) throw new Error("journal_dungeon_invalid");
      dungeons.set(dungeon.journalDungeonId, dungeon);
    }
  }
  return [...dungeons.values()].sort(
    (a, b) => Number(a.journalDungeonId) - Number(b.journalDungeonId)
  );
}
