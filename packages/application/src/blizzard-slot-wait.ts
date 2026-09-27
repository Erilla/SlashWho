import type { BlizzardSlotWait } from "@slashwho/blizzard";

import type { ExcludeFromBucket, MeasurementScope } from "./measurement";

/**
 * Time spent queued in a Blizzard client's request limiter is not Blizzard's:
 * it is kept out of the enclosing `blizzard` bucket, so the per-call mean and
 * maximum stay latencies, and reported on its own as `blizzardLimiterWaitMs`.
 */
export function excludeBlizzardSlotWait(
  scope: MeasurementScope,
  monotonic: () => number,
  excluded: ExcludeFromBucket
): BlizzardSlotWait {
  return (wait) =>
    excluded(async () => {
      const queuedAt = monotonic();
      try {
        return await wait();
      } finally {
        scope.observe("blizzardLimiterWaitMs", monotonic() - queuedAt);
      }
    });
}
