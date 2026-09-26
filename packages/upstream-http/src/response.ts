import type { UpstreamFailure } from "./failure";

export type ThrottleEvent = { retryAfterMs: number | undefined };

export type ThrottleObserver = (event: ThrottleEvent) => void;

/** Reads `Retry-After` as either delta-seconds or an HTTP date. */
export function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return undefined;

  if (/^\d+$/.test(value)) return Number(value) * 1_000;

  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now())
    : undefined;
}

/**
 * A reporting callback must never change what a client returns. If the
 * logger behind `onThrottle` throws, the raw thrown value would otherwise
 * replace the failure being built, degrading a genuine rate limit into an
 * unavailable upstream. Swallowed silently: there is no safe place to report a
 * failure of the reporting path itself, and it must not become a second
 * failure.
 */
export function reportThrottle(
  onThrottle: ThrottleObserver | undefined,
  retryAfterMs: number | undefined
): void {
  try {
    onThrottle?.({ retryAfterMs });
  } catch {
    // Intentionally ignored; see above.
  }
}

/**
 * Classifies a response that was not `ok`. A 404 or 403 speaks for the thing
 * asked about and is final. Anything else is transient, and carries its status
 * and any `Retry-After` so a caller can wait as long as upstream asked.
 *
 * Upstream asking us to back off is throttling whether or not it also sent
 * 429 -- a 503 carrying `Retry-After` is the same signal -- so either fires
 * `onThrottle`. A 401 is deliberately transient: it is our token being
 * refused, which says nothing about the thing asked about (#563).
 */
export function classifyResponse(
  response: Response,
  onThrottle?: ThrottleObserver
): UpstreamFailure {
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 403) return { kind: "forbidden" };

  const retryAfter = retryAfterMs(response);
  if (response.status === 429 || retryAfter !== undefined) {
    reportThrottle(onThrottle, retryAfter);
  }
  return {
    kind: "transient",
    status: response.status,
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter })
  };
}
