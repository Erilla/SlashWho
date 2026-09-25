import catalogue from "./cutting-edge-catalogue.generated.json";

export type CuttingEdgeCatalogueAchievement = Readonly<{
  achievementId: string;
  achievementName: string;
  description: string;
  iconUrl: string | null;
  categoryId: string;
  scope: "account_wide";
}>;

export type CuttingEdgeSequenceEntry<T> =
  | Readonly<{ status: "recorded"; achievement: T }>
  | Readonly<{
      status: "not_recorded";
      achievement: CuttingEdgeCatalogueAchievement;
    }>;

const orderedAchievements: readonly CuttingEdgeCatalogueAchievement[] =
  catalogue.achievements.map((achievement) => ({
    ...achievement,
    scope: "account_wide" as const
  }));

const achievements = new Map<string, CuttingEdgeCatalogueAchievement>(
  orderedAchievements.map((achievement) => [
    achievement.achievementId,
    achievement
  ])
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

export function buildCuttingEdgeSequence<
  T extends Readonly<{ achievementId: string }>
>(recordedAchievements: readonly T[]): readonly CuttingEdgeSequenceEntry<T>[] {
  const recordedById = new Map<string, T[]>();
  for (const achievement of recordedAchievements) {
    recordedById.set(achievement.achievementId, [
      ...(recordedById.get(achievement.achievementId) ?? []),
      achievement
    ]);
  }

  const hasUnknownAchievement = recordedAchievements.some(
    (achievement) => !achievements.has(achievement.achievementId)
  );
  if (recordedAchievements.length === 0 || hasUnknownAchievement) {
    return recordedAchievements.map((achievement) => ({
      status: "recorded",
      achievement
    }));
  }

  const sequence: CuttingEdgeSequenceEntry<T>[] = [];
  for (const achievement of [...orderedAchievements].reverse()) {
    const recorded = recordedById.get(achievement.achievementId);
    if (recorded) {
      for (const entry of recorded) {
        sequence.push({ status: "recorded", achievement: entry });
      }
    } else {
      sequence.push({ status: "not_recorded", achievement });
    }
  }
  return sequence;
}
