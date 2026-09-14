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
  const emittedGaps = new Set<string>();
  for (const [index, recorded] of recordedAchievements.entries()) {
    sequence.push({ status: "recorded", achievement: recorded });
    const currentIndex = orderedAchievements.findIndex(
      (achievement) => achievement.achievementId === recorded.achievementId
    );
    const next = recordedAchievements[index + 1];
    const nextIndex = next
      ? orderedAchievements.findIndex(
          (achievement) => achievement.achievementId === next.achievementId
        )
      : -1;
    if (currentIndex < 0 || nextIndex < 0) continue;
    const between = orderedAchievements.slice(
      Math.min(currentIndex, nextIndex) + 1,
      Math.max(currentIndex, nextIndex)
    );
    if (currentIndex > nextIndex) between.reverse();
    for (const achievement of between) {
      if (
        !recordedById.has(achievement.achievementId) &&
        !emittedGaps.has(achievement.achievementId)
      ) {
        sequence.push({ status: "not_recorded", achievement });
        emittedGaps.add(achievement.achievementId);
      }
    }
  }
  for (const achievement of orderedAchievements
    .slice(first, last + 1)
    .reverse()) {
    if (
      !recordedById.has(achievement.achievementId) &&
      !emittedGaps.has(achievement.achievementId)
    ) {
      sequence.push({ status: "not_recorded", achievement });
    }
  }
  return sequence;
}
