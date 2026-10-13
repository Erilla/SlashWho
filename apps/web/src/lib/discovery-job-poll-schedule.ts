import { createBackoff } from "./use-authoritative-poll";

/** The first snapshot usually arrives in seconds; long watches back off. */
export function createDiscoveryJobPollSchedule(
  now: () => number = () => performance.now()
) {
  const startedAt = now();
  const fallback = createBackoff([4_000, 8_000, 10_000]);
  let first = true;
  return {
    next(): number {
      if (now() - startedAt >= 90_000) return fallback.next();
      if (!first) return 2_000;
      first = false;
      return 1_000;
    }
  };
}
