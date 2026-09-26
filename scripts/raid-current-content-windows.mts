import { record } from "./lib/json.mts";

export type GeneratedRaidCurrentContentWindow = Readonly<{
  startsAt: string;
  endsAt: string | null;
}>;

export type GeneratedRaidCurrentContentWindowSnapshot = Readonly<{
  source: "raiderio-raiding-static-data";
  generatedAt: string;
  windows: Readonly<Record<string, GeneratedRaidCurrentContentWindow>>;
}>;

// Raider.IO publishes raiding static data per expansion. Legion (6) is the
// earliest expansion it serves; older expansions answer 400 and carry no
// schedule, so their raids stay uncovered rather than guessed.
export const raiderIoExpansionIds = [6, 7, 8, 9, 10, 11] as const;

// Raider.IO marks a season whose end Blizzard has not announced with a
// far-future placeholder. Recording it verbatim would expire the window on a
// date nobody published, so treat it as open-ended.
const openEndedAtOrAfter = Date.parse("2030-01-01T00:00:00.000Z");

function nonEmptySlug(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9-]+$/.test(value) ? value : null;
}

/** Region timestamps for one schedule boundary, earliest and latest first. */
function boundaries(value: unknown): readonly number[] {
  const regions = record(value);
  if (!regions) return [];
  return Object.values(regions).flatMap((timestamp) => {
    if (typeof timestamp !== "string") return [];
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) ? [] : [parsed];
  });
}

/**
 * A raid is current somewhere in the world from its earliest regional opening
 * until its latest regional close. Taking the union rather than one region's
 * schedule keeps a kill from being judged legacy because another region's
 * reset landed first.
 */
export function normalizeRaidCurrentContentWindow(value: unknown): Readonly<{
  slug: string;
  window: GeneratedRaidCurrentContentWindow;
}> | null {
  const raid = record(value);
  const slug = raid && nonEmptySlug(raid.slug);
  if (!slug) return null;
  const starts = boundaries(raid.starts);
  const ends = boundaries(raid.ends);
  if (starts.length === 0) return null;
  const startsAt = Math.min(...starts);
  const latestEnd = ends.length === 0 ? null : Math.max(...ends);
  const endsAt =
    latestEnd === null || latestEnd >= openEndedAtOrAfter ? null : latestEnd;
  if (endsAt !== null && endsAt <= startsAt) return null;
  return {
    slug,
    window: {
      startsAt: new Date(startsAt).toISOString(),
      endsAt: endsAt === null ? null : new Date(endsAt).toISOString()
    }
  };
}

export function normalizeRaidCurrentContentWindows(
  payloads: readonly unknown[]
): Readonly<Record<string, GeneratedRaidCurrentContentWindow>> {
  const windows = new Map<string, GeneratedRaidCurrentContentWindow>();
  for (const payload of payloads) {
    const raids = record(payload)?.raids;
    if (!Array.isArray(raids)) continue;
    for (const raid of raids) {
      const normalized = normalizeRaidCurrentContentWindow(raid);
      if (normalized) windows.set(normalized.slug, normalized.window);
    }
  }
  return Object.fromEntries(
    [...windows].sort(([a], [b]) => a.localeCompare(b))
  );
}

export type FetchRaidCurrentContentWindowsOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  baseUrl: URL;
  expansionIds?: readonly number[];
}>;

export async function fetchRaidCurrentContentWindows(
  options: FetchRaidCurrentContentWindowsOptions
): Promise<Readonly<Record<string, GeneratedRaidCurrentContentWindow>>> {
  const expansionIds = options.expansionIds ?? raiderIoExpansionIds;
  const payloads: unknown[] = [];
  for (const expansionId of expansionIds) {
    const url = new URL("/api/v1/raiding/static-data", options.baseUrl);
    url.searchParams.set("expansion_id", String(expansionId));
    const response = await options.fetch(url, {
      headers: { accept: "application/json" }
    });
    // Expansions Raider.IO does not serve answer 400. Skipping them leaves
    // their raids uncovered, which the domain guard reports explicitly.
    if (response.status === 400) continue;
    if (!response.ok) throw new Error("raiderio_static_data_failed");
    payloads.push(await response.json());
  }
  const windows = normalizeRaidCurrentContentWindows(payloads);
  if (Object.keys(windows).length === 0) {
    throw new Error("raiderio_static_data_empty");
  }
  return windows;
}
