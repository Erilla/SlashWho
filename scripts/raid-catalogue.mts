type JournalEncounter = Readonly<{
  id: unknown;
  name: unknown;
}>;

type JournalRaid = Readonly<{
  id: unknown;
  name: unknown;
  category: unknown;
  modes: unknown;
  encounters: unknown;
}>;

export function isDirectExecution(moduleUrl: string, invokedPath: string): boolean {
  return new URL(moduleUrl).pathname.replace(/^\//, "") === invokedPath.replace(/\\/g, "/");
}

export type GeneratedJournalRaid = Readonly<{
  journalRaidId: string;
  raidName: string;
  encounters: readonly Readonly<{
    journalBossId: string;
    bossName: string;
    bossOrder: number;
  }>[];
}>;

export type FetchJournalRaidsOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  accessToken: string;
  baseUrl: URL;
  region?: string;
  locale?: string;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function normalizeJournalRaid(value: unknown): GeneratedJournalRaid | null {
  const raid = value as JournalRaid;
  const category = record(raid.category);
  if (category?.type !== "RAID" || !Array.isArray(raid.modes)) return null;
  const hasMythicMode = raid.modes.some((value) => {
    const mode = record(value);
    return record(mode?.mode)?.type === "MYTHIC";
  });
  if (!hasMythicMode || !Array.isArray(raid.encounters)) return null;

  const journalRaidId = positiveInteger(raid.id);
  const raidName = nonEmptyString(raid.name);
  if (!journalRaidId || !raidName) return null;

  const encounters = raid.encounters.map((value, index) => {
    const encounter = value as JournalEncounter;
    const journalBossId = positiveInteger(encounter.id);
    const bossName = nonEmptyString(encounter.name);
    return journalBossId && bossName
      ? { journalBossId: String(journalBossId), bossName, bossOrder: index + 1 }
      : null;
  });
  if (encounters.length === 0 || encounters.some((entry) => entry === null)) {
    return null;
  }
  return {
    journalRaidId: String(journalRaidId),
    raidName,
    encounters: encounters as GeneratedJournalRaid["encounters"]
  };
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
  options: FetchJournalRaidsOptions,
  url: URL
): Promise<Record<string, unknown>> {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set(
    "namespace",
    `static-${options.region ?? "eu"}`
  );
  requestUrl.searchParams.set("locale", options.locale ?? "en_GB");
  const response = await options.fetch(requestUrl, {
    headers: { Authorization: `Bearer ${options.accessToken}` }
  });
  if (!response.ok) throw new Error(`journal_request_failed_${response.status}`);
  const body = record(await response.json());
  if (!body) throw new Error("journal_response_invalid");
  return body;
}

export async function fetchJournalRaids(
  options: FetchJournalRaidsOptions
): Promise<readonly GeneratedJournalRaid[]> {
  const indexUrl = new URL("/data/wow/journal-expansion/index", options.baseUrl);
  const index = await jsonRequest(options, indexUrl);
  if (!Array.isArray(index.tiers)) throw new Error("journal_tiers_invalid");

  const raidUrls = new Map<string, URL>();
  for (const tier of index.tiers) {
    const tierUrl = href(tier, options.baseUrl);
    if (!tierUrl) throw new Error("journal_tier_href_invalid");
    const tierBody = await jsonRequest(options, tierUrl);
    if (!Array.isArray(tierBody.raids)) throw new Error("journal_raids_invalid");
    for (const raid of tierBody.raids) {
      const raidUrl = href(raid, options.baseUrl);
      if (!raidUrl) throw new Error("journal_raid_href_invalid");
      raidUrls.set(raidUrl.toString(), raidUrl);
    }
  }

  const raids = new Map<string, GeneratedJournalRaid>();
  for (const raidUrl of raidUrls.values()) {
    const raid = normalizeJournalRaid(await jsonRequest(options, raidUrl));
    if (raid) raids.set(raid.journalRaidId, raid);
  }
  return [...raids.values()].sort(
    (a, b) => Number(a.journalRaidId) - Number(b.journalRaidId)
  );
}
