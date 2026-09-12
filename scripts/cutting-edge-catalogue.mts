type JsonRecord = Record<string, unknown>;

export type GeneratedCuttingEdgeAchievement = Readonly<{
  achievementId: string;
  achievementName: string;
  description: string;
  categoryId: "15271";
}>;

export type FetchCuttingEdgeAchievementsOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  accessToken: string;
  baseUrl: URL;
  region?: string;
  locale?: string;
}>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
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
  return {
    achievementId: String(id),
    achievementName,
    description,
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
  const ids = entries.flatMap((entry) => {
    const candidate = record(entry);
    const id = positiveInteger(candidate?.id);
    const name = nonEmptyString(candidate?.name);
    return id !== null && name?.startsWith("Cutting Edge:") ? [id] : [];
  });
  return Promise.all(ids.map((id) => fetchDefinition(options, id))).then(
    (items) =>
      items.sort((a, b) => Number(a.achievementId) - Number(b.achievementId))
  );
}
