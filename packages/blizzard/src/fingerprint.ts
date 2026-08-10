import type { AchievementFingerprint } from "./types";

const mandatoryMinimumCommon = 200;
const mandatoryMinimumIdenticalPercent = 20;

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
  const minimumCommon = Math.max(mandatoryMinimumCommon, policy.minimumCommon);
  const minimumIdenticalPercent = Math.max(
    mandatoryMinimumIdenticalPercent,
    policy.minimumIdenticalPercent
  );
  return {
    common,
    identical,
    isMatch:
      common >= minimumCommon && identicalPercent >= minimumIdenticalPercent
  };
}
