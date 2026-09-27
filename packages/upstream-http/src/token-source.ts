import { createUpstreamError, type UpstreamFailure } from "./failure";
import { finiteNumber, nonEmptyString, record } from "./narrow";
import { classifyResponse, type ThrottleObserver } from "./response";

export type ClientCredentialsTokenSourceOptions = Readonly<{
  /** Prefixes the message of every error this source throws. */
  provider: string;
  fetch: typeof globalThis.fetch;
  url: URL;
  clientId: string;
  clientSecret: string;
  onThrottle?: ThrottleObserver | undefined;
  /** How long one token request may take. Defaults to 15 seconds. */
  deadlineMs?: number;
}>;

export type ClientCredentialsTokenSource = Readonly<{
  /**
   * Resolves a bearer token, reusing a cached one until a minute before it
   * expires. Throws an `UpstreamError` when no token could be had, or the
   * caller's abort reason when the caller gave up waiting.
   */
  token(signal?: AbortSignal): Promise<string>;
  /**
   * Drops `token` from the cache after upstream refused it, so the next
   * request asks for a fresh one rather than failing until the cached expiry.
   * A token other than the one cached is ignored: a concurrent request may
   * already have replaced it.
   */
  invalidate(token: string): void;
}>;

type CachedToken = Readonly<{ value: string; expiresAt: number }>;

/**
 * An OAuth client-credentials token cache with single flight: concurrent
 * callers share one token request rather than each asking for their own.
 */
export function createClientCredentialsTokenSource(
  options: ClientCredentialsTokenSourceOptions
): ClientCredentialsTokenSource {
  const deadlineMs = options.deadlineMs ?? 15_000;
  let cached: CachedToken | undefined;
  let pending: Promise<string> | undefined;

  const fail = (failure: UpstreamFailure) =>
    createUpstreamError(options.provider, failure);

  async function token(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    pending ??= fetchToken(AbortSignal.timeout(deadlineMs)).finally(() => {
      pending = undefined;
    });
    const value = await pending;
    signal?.throwIfAborted();
    return value;
  }

  // The signal is the token request's own deadline, never a caller's: the
  // request is shared, so its expiry is an upstream failure, not a
  // cancellation, and is reported like any other (#564).
  async function fetchToken(deadline: AbortSignal): Promise<string> {
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let response: Response;
    try {
      response = await options.fetch(options.url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(
            `${options.clientId}:${options.clientSecret}`
          ).toString("base64")}`
        },
        body: "grant_type=client_credentials",
        signal: deadline
      });
    } catch {
      throw fail({ kind: "transient" });
    }

    if (deadline.aborted) throw fail({ kind: "transient" });
    if (!response.ok) {
      // The token endpoint answers for our credentials, never for the thing
      // a caller asked about: a refusal here is ours, so it must not read as
      // `not_found` or `forbidden`, which are statements about that thing
      // (#563).
      const failure = classifyResponse(response, options.onThrottle);
      throw fail(
        failure.kind === "transient"
          ? failure
          : { kind: "transient", status: response.status }
      );
    }

    try {
      const body = record(await response.json());
      if (deadline.aborted) throw new Error("token_deadline");
      const value = body && nonEmptyString(body.access_token);
      const expiresIn = body && finiteNumber(body.expires_in);
      if (!value || expiresIn === null || expiresIn <= 0) {
        throw new Error("invalid_token_response");
      }
      cached = {
        value,
        expiresAt: Date.now() + Math.max(0, expiresIn * 1_000 - 60_000)
      };
      return value;
    } catch {
      if (deadline.aborted) throw fail({ kind: "transient" });
      throw fail({ kind: "schema_drift" });
    }
  }

  return {
    token,
    invalidate(value) {
      if (cached?.value === value) cached = undefined;
    }
  };
}
