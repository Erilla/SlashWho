import catalogue from "./cutting-edge-catalogue.generated.json";

export type CuttingEdgeCatalogueAchievement = Readonly<{
  achievementId: string;
  achievementName: string;
  description: string;
  categoryId: string;
}>;

const achievements = new Map<string, CuttingEdgeCatalogueAchievement>(
  catalogue.achievements.map((achievement) => [
    achievement.achievementId,
    achievement
  ])
);

export function lookupCuttingEdgeAchievement(
  achievementId: string
): CuttingEdgeCatalogueAchievement | null {
  return achievements.get(achievementId) ?? null;
}
