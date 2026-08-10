import type { AchievementFingerprint } from "./types";

export function compareFingerprints(
  root: AchievementFingerprint,
  candidate: AchievementFingerprint,
  policy: { minimumCommon: number; minimumIdenticalPercent: number }
): { common: number; identical: number; isMatch: boolean } {
  let common = 0;
  let identical = 0;

  for (const [achievementId, timestamp] of root) {
    const candidateTimestamp = candidate.get(achievementId);
    if (candidateTimestamp === undefined) continue;

    common += 1;
    if (candidateTimestamp === timestamp) identical += 1;
  }

  const identicalPercent = common === 0 ? 0 : (identical / common) * 100;
  return {
    common,
    identical,
    isMatch:
      common >= policy.minimumCommon &&
      identicalPercent >= policy.minimumIdenticalPercent
  };
}
