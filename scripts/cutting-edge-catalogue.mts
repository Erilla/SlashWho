import { nonEmptyString, positiveInteger, record } from "./lib/json.mts";

type JsonRecord = Record<string, unknown>;

export type GeneratedCuttingEdgeAchievement = Readonly<{
  achievementId: string;
  achievementName: string;
  description: string;
  iconUrl: string | null;
  categoryId: "15271";
}>;

export type FetchCuttingEdgeAchievementsOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  accessToken: string;
  baseUrl: URL;
  region?: string;
  locale?: string;
}>;

const historicalAchievementIds = [
  "7485",
  "7486",
  "7487",
  "8238",
  "8260",
  "8400",
  "8401",
  "9442",
  "9443",
  "10045",
  "11191",
  "11580",
  "11192",
  "11875",
  "12111",
  "12535",
  "13323",
  "13419",
  "13785",
  "14069",
  "14461",
  "15135",
  "15471",
  "17108",
  "18254",
  "19351",
  "40254",
  "41297",
  "41625",
  "61492",
  "61625",
  "61627",
  "63651"
] as const;
const historicalOrder = new Map<string, number>(
  historicalAchievementIds.map((achievementId, index) => [achievementId, index])
);

export function sortCuttingEdgeAchievementsChronologically(
  achievements: readonly GeneratedCuttingEdgeAchievement[]
): readonly GeneratedCuttingEdgeAchievement[] {
  for (const achievement of achievements) {
    if (!historicalOrder.has(achievement.achievementId)) {
      throw new Error(
        `cutting_edge_chronology_missing_${achievement.achievementId}`
      );
    }
  }
  return [...achievements].sort(
    (a, b) =>
      historicalOrder.get(a.achievementId)! -
      historicalOrder.get(b.achievementId)!
  );
}

async function jsonRequest(
  options: FetchCuttingEdgeAchievementsOptions,
  path: string
): Promise<JsonRecord> {
  const url = new URL(path, options.baseUrl);
  url.searchParams.set("namespace", `static-${options.region ?? "eu"}`);
  url.searchParams.set("locale", options.locale ?? "en_GB");
  const response = await options.fetch(url, {
    headers: { Authorization: `Bearer ${options.accessToken}` }
  });
  if (!response.ok)
    throw new Error(`cutting_edge_request_failed_${response.status}`);
  const body = record(await response.json());
  if (!body) throw new Error("cutting_edge_response_invalid");
  return body;
}

function mediaAsset(media: JsonRecord, key: string): string | null {
  if (!Array.isArray(media.assets)) return null;
  const asset = media.assets
    .map(record)
    .find((candidate) => candidate?.key === key);
  return asset ? nonEmptyString(asset.value) : null;
}

function categoryContainsRaids(category: JsonRecord): boolean {
  const categories = category.subcategories;
  if (!Array.isArray(categories)) return false;
  return categories.some(
    (entry) => positiveInteger(record(entry)?.id) === 15271
  );
}

async function fetchDefinition(
  options: FetchCuttingEdgeAchievementsOptions,
  achievementId: number
): Promise<GeneratedCuttingEdgeAchievement> {
  const achievement = await jsonRequest(
    options,
    `/data/wow/achievement/${achievementId}`
  );
  const id = positiveInteger(achievement.id);
  const achievementName = nonEmptyString(achievement.name);
  const description = nonEmptyString(achievement.description);
  const categoryId = positiveInteger(record(achievement.category)?.id);
  if (
    id !== achievementId ||
    !achievementName?.startsWith("Cutting Edge:") ||
    !description ||
    categoryId !== 15271
  ) {
    throw new Error("cutting_edge_achievement_invalid");
  }
  const media = await jsonRequest(options, `/data/wow/media/achievement/${id}`);
  return {
    achievementId: String(id),
    achievementName,
    description,
    iconUrl: mediaAsset(media, "icon"),
    categoryId: "15271"
  };
}

export async function fetchCuttingEdgeAchievements(
  options: FetchCuttingEdgeAchievementsOptions
): Promise<readonly GeneratedCuttingEdgeAchievement[]> {
  const feats = await jsonRequest(options, "/data/wow/achievement-category/81");
  if (!categoryContainsRaids(feats)) {
    throw new Error("cutting_edge_category_parent_invalid");
  }
  const raids = await jsonRequest(
    options,
    "/data/wow/achievement-category/15271"
  );
  if (positiveInteger(record(raids.parent_category)?.id) !== 81) {
    throw new Error("cutting_edge_category_parent_invalid");
  }
  const entries = raids.achievements;
  if (!Array.isArray(entries)) throw new Error("cutting_edge_category_invalid");
  const ids = new Set(
    entries.flatMap((entry) => {
      const candidate = record(entry);
      const id = positiveInteger(candidate?.id);
      const name = nonEmptyString(candidate?.name);
      return id !== null && name?.startsWith("Cutting Edge:") ? [id] : [];
    })
  );
  return Promise.all([...ids].map((id) => fetchDefinition(options, id))).then(
    sortCuttingEdgeAchievementsChronologically
  );
}
