import catalogue from "./cutting-edge-catalogue.generated.json";

export type CuttingEdgeCatalogueAchievement = Readonly<{
  achievementId: string;
  achievementName: string;
  description: string;
  categoryId: string;
  scope: "account_wide";
}>;

const achievements = new Map<string, CuttingEdgeCatalogueAchievement>(
  catalogue.achievements.map((achievement) => {
    // This generated catalogue is the explicit allowlist for the only
    // achievements we may treat as account-wide. The wider Blizzard response
    // contains achievement types with different ownership semantics.
    const classified = { ...achievement, scope: "account_wide" as const };
    return [classified.achievementId, classified];
  })
);

export function lookupCuttingEdgeAchievement(
  achievementId: string
): CuttingEdgeCatalogueAchievement | null {
  return achievements.get(achievementId) ?? null;
}

export function isAccountWideCuttingEdgeAchievement(
  achievementId: string
): boolean {
  return lookupCuttingEdgeAchievement(achievementId)?.scope === "account_wide";
}
