/**
 * How the client reaches Warcraft Logs: the client-credentials token, the
 * GraphQL request, and how an HTTP status or error envelope becomes a
 * limitation. It knows nothing about characters, reports or rankings.
 */
import type { WarcraftLogsLimitation } from "./types";
import {
  nonEmptyString,
  nonNegativeFiniteNumber,
  record
} from "./decode/primitives";

type AccessToken = Readonly<{
  value: string;
  expiresAt: number;
}>;

export type GraphqlSuccess = Readonly<{ kind: "success"; value: unknown }>;
export type GraphqlResult = GraphqlSuccess | WarcraftLogsLimitation;

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;

  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now())
    : undefined;
}

/**
 * A reporting callback must never change what this client returns. If the
 * logger behind `onThrottle` throws, the raw thrown value would otherwise
 * replace the failure being built here, degrading a genuine rate limit into an
 * unavailable upstream. Swallowed silently: there is no safe place to report a
 * failure of the reporting path itself, and it must not become a second
 * failure.
 */
function reportThrottle(
  onThrottle:
    ((event: { retryAfterMs: number | undefined }) => void) | undefined,
  retryAfterMs: number | undefined
): void {
  try {
    onThrottle?.({ retryAfterMs });
  } catch {
    // Intentionally ignored; see above.
  }
}

function responseLimitation(
  response: Response,
  onThrottle?: (event: { retryAfterMs: number | undefined }) => void
): WarcraftLogsLimitation {
  if (response.status === 404) return { kind: "limitation", code: "not_found" };
  // Only 403 speaks for the thing asked about. A 401 is our token being
  // refused, which says nothing about the character, and falls through to
  // `unavailable` below (#563).
  if (response.status === 403) return { kind: "limitation", code: "private" };
  // Upstream asking us to back off is throttling whether or not it also sent
  // 429 — a 503 carrying Retry-After is the same signal. This affects only
  // when onThrottle fires, never the limitation this function returns.
  const retryAfter = retryAfterMs(response);
  if (response.status === 429 || retryAfter !== undefined) {
    reportThrottle(onThrottle, retryAfter);
  }
  if (response.status === 429) {
    return {
      kind: "limitation",
      code: "rate_limited",
      ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter })
    };
  }
  return { kind: "limitation", code: "unavailable" };
}

function firstGraphQlError(
  value: unknown
): { message: string | null; code: string | null } | null {
  const envelope = record(value);
  const errors = envelope && envelope.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;

  const error = record(errors[0]);
  const extensions = error && record(error.extensions);
  return {
    message:
      (error && nonEmptyString(error.message)?.toLocaleLowerCase("en-US")) ??
      null,
    code:
      (extensions &&
        nonEmptyString(extensions.code)?.toLocaleUpperCase("en-US")) ??
      null
  };
}

/**
 * Whether an error message says the thing asked about is closed to us. Shared
 * by both readers below so that an envelope `graphQlErrorLimitation` would
 * call private is never first taken for a refused token.
 */
function messageSaysPrivate(message: string | null): boolean {
  return (
    message !== null &&
    (message.includes("private") ||
      message.includes("forbidden") ||
      message.includes("not authorized"))
  );
}

/**
 * Whether a GraphQL envelope refuses our token rather than the thing asked
 * for. `UNAUTHORIZED` was read as a private character until #563, which made
 * a revoked token look like every player it touched choosing privacy. One
 * whose message says the thing is private is still private: taking it for a
 * refused token would drop the shared token and hold a gone report's kill.
 */
function graphQlAuthRejected(value: unknown): boolean {
  const error = firstGraphQlError(value);
  return (
    (error?.code === "UNAUTHORIZED" || error?.code === "UNAUTHENTICATED") &&
    !messageSaysPrivate(error.message)
  );
}

function graphQlErrorLimitation(value: unknown): WarcraftLogsLimitation | null {
  const error = firstGraphQlError(value);
  if (!error) return null;
  const { message, code } = error;
  // "This report does not exist." is what Warcraft Logs answers for a missing
  // report code (recorded 2026-09-23), with `report: null` beside it. Read as
  // `unavailable`, a deleted report looked transient and held a run partial
  // on every retry.
  if (
    code === "NOT_FOUND" ||
    message?.includes("not found") ||
    message?.includes("does not exist")
  ) {
    return { kind: "limitation", code: "not_found" };
  }
  if (code === "FORBIDDEN" || messageSaysPrivate(message)) {
    return { kind: "limitation", code: "private" };
  }
  return { kind: "limitation", code: "unavailable" };
}

export type GraphqlVariables = Record<
  string,
  string | number | readonly number[]
>;

export type WarcraftLogsTransport = Readonly<{
  graphql(
    query: string,
    variables: GraphqlVariables,
    signal?: AbortSignal
  ): Promise<GraphqlResult>;
}>;

export function createTransport(
  options: Readonly<{
    fetch: typeof globalThis.fetch;
    clientId: string;
    clientSecret: string;
    baseUrl?: URL;
    onThrottle?(event: { retryAfterMs: number | undefined }): void;
  }>
): WarcraftLogsTransport {
  const baseUrl = options.baseUrl;
  let cachedToken: AccessToken | undefined;
  let tokenRequest: Promise<string | WarcraftLogsLimitation> | undefined;

  function tokenUrl(): URL {
    return new URL("/oauth/token", baseUrl ?? "https://www.warcraftlogs.com");
  }

  function graphqlUrl(): URL {
    return new URL("/api/v2/client", baseUrl ?? "https://www.warcraftlogs.com");
  }

  async function accessToken(
    signal?: AbortSignal
  ): Promise<string | WarcraftLogsLimitation> {
    signal?.throwIfAborted();
    tokenRequest ??= fetchAccessToken(AbortSignal.timeout(15_000)).finally(
      () => {
        tokenRequest = undefined;
      }
    );
    const token = await tokenRequest;
    signal?.throwIfAborted();
    return token;
  }

  // The signal is the token request's own deadline, never a caller's: the
  // request is shared, so its expiry is an upstream failure, not a
  // cancellation, and is reported like any other.
  async function fetchAccessToken(
    signal?: AbortSignal
  ): Promise<string | WarcraftLogsLimitation> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
      return cachedToken.value;
    }

    let response: Response;
    try {
      response = await options.fetch(tokenUrl().toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(
            `${options.clientId}:${options.clientSecret}`
          ).toString("base64")}`
        },
        body: "grant_type=client_credentials",
        signal
      });
    } catch {
      return { kind: "limitation", code: "unavailable" };
    }

    if (signal?.aborted) return { kind: "limitation", code: "unavailable" };
    if (!response.ok) {
      // The token endpoint answers for our credentials, never for a
      // character: a refusal here is ours, so it must not read as `private`
      // or `not_found`, which are statements about the player (#563).
      const limitation = responseLimitation(response, options.onThrottle);
      return limitation.code === "rate_limited"
        ? limitation
        : { kind: "limitation", code: "unavailable" };
    }
    try {
      const body = record(await response.json());
      if (signal?.aborted) return { kind: "limitation", code: "unavailable" };
      const value = body && nonEmptyString(body.access_token);
      const expiresIn = body && nonNegativeFiniteNumber(body.expires_in);
      if (!value || expiresIn === null || expiresIn <= 0) {
        return { kind: "limitation", code: "schema_drift" };
      }
      cachedToken = {
        value,
        expiresAt: Date.now() + Math.max(0, expiresIn * 1_000 - 60_000)
      };
      return value;
    } catch {
      if (signal?.aborted) return { kind: "limitation", code: "unavailable" };
      return { kind: "limitation", code: "schema_drift" };
    }
  }

  /**
   * A token refused before its cached expiry -- revoked or rotated upstream
   * -- would otherwise fail every request until the expiry passed. So a
   * refusal drops the cached token and asks once more with a fresh one. A
   * refusal that survives that is ours to fix, not the character's: it reads
   * as `unavailable`, which retries, never as `private`, which does not and
   * which lets a stored kill go (#563).
   */
  async function graphql(
    query: string,
    variables: GraphqlVariables,
    signal?: AbortSignal
  ): Promise<GraphqlResult> {
    const first = await graphqlOnce(query, variables, signal);
    if (first !== "auth_rejected") return first;
    const second = await graphqlOnce(query, variables, signal);
    return second === "auth_rejected"
      ? { kind: "limitation", code: "unavailable" }
      : second;
  }

  async function graphqlOnce(
    query: string,
    variables: GraphqlVariables,
    signal?: AbortSignal
  ): Promise<GraphqlResult | "auth_rejected"> {
    const token = await accessToken(signal);
    if (typeof token !== "string") return token;
    signal?.throwIfAborted();
    const rejected = () => {
      // Only the token this request carried. A concurrent request may
      // already have replaced it with a fresh one.
      if (cachedToken?.value === token) cachedToken = undefined;
      return "auth_rejected" as const;
    };

    let response: Response;
    try {
      response = await options.fetch(graphqlUrl().toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query, variables }),
        signal
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "limitation", code: "unavailable" };
    }

    signal?.throwIfAborted();
    if (response.status === 401) return rejected();
    if (!response.ok) return responseLimitation(response, options.onThrottle);
    try {
      const body = await response.json();
      signal?.throwIfAborted();
      if (graphQlAuthRejected(body)) return rejected();
      return graphQlErrorLimitation(body) ?? { kind: "success", value: body };
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "limitation", code: "schema_drift" };
    }
  }

  return { graphql };
}
