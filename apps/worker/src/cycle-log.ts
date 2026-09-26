/** A monotonic millisecond reading, so a wall-clock step never skews a duration. */
export type Clock = () => number;

export const monotonicClock: Clock = performance.now.bind(performance);

/** Whole milliseconds since `startedAt`, never negative. */
export function elapsedMs(clock: Clock, startedAt: number): number {
  return Math.max(0, Math.round(clock() - startedAt));
}

/**
 * The error's class name, reduced to identifier characters and bounded in
 * length -- the same rule as the web `http_request` record. Never the message,
 * which can carry a recipient, a URL or an upstream payload.
 */
export function errorName(error: unknown): string {
  const raw =
    error instanceof Error
      ? (error.constructor?.name ?? error.name)
      : typeof error;
  return raw.replaceAll(/[^A-Za-z0-9_]/g, "").slice(0, 64) || "unknown";
}
