import catalogue from "./cutting-edge-catalogue.generated.json";

export type CuttingEdgeCatalogueAchievement = Readonly<{
  achievementId: string;
  achievementName: string;
  description: string;
  iconUrl: string | null;
  categoryId: string;
}>;

export type CuttingEdgeSequenceEntry<T> =
  | Readonly<{ status: "recorded"; achievement: T }>
  | Readonly<{
      status: "not_recorded";
      achievement: CuttingEdgeCatalogueAchievement;
    }>;

const orderedAchievements: readonly CuttingEdgeCatalogueAchievement[] =
  catalogue.achievements;

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

export function buildBoundedCuttingEdgeSequence<
  T extends Readonly<{ achievementId: string }>
>(recordedAchievements: readonly T[]): readonly CuttingEdgeSequenceEntry<T>[] {
  const recordedById = new Map<string, T[]>();
  for (const achievement of recordedAchievements) {
    recordedById.set(achievement.achievementId, [
      ...(recordedById.get(achievement.achievementId) ?? []),
      achievement
    ]);
  }

  const knownIndexes = orderedAchievements
    .map((achievement, index) =>
      recordedById.has(achievement.achievementId) ? index : null
    )
    .filter((index): index is number => index !== null);
  const hasUnknownAchievement = recordedAchievements.some(
    (achievement) => !achievements.has(achievement.achievementId)
  );
  if (knownIndexes.length < 2 || hasUnknownAchievement) {
    return recordedAchievements.map((achievement) => ({
      status: "recorded",
      achievement
    }));
  }

  const first = Math.min(...knownIndexes);
  const last = Math.max(...knownIndexes);
  const sequence: CuttingEdgeSequenceEntry<T>[] = [];
  for (const achievement of orderedAchievements.slice(first, last + 1)) {
    const recorded = recordedById.get(achievement.achievementId);
    if (recorded) {
      sequence.push(
        ...recorded.map((item) => ({
          status: "recorded" as const,
          achievement: item
        }))
      );
    } else {
      sequence.push({ status: "not_recorded", achievement });
    }
  }
  return sequence;
}
