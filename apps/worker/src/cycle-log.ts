/** A monotonic millisecond reading, so a wall-clock step never skews a duration. */
export type Clock = () => number;

export const monotonicClock: Clock = performance.now.bind(performance);

/** Whole milliseconds since `startedAt`, never negative. */
export function elapsedMs(clock: Clock, startedAt: number): number {
  return Math.max(0, Math.round(clock() - startedAt));
}
