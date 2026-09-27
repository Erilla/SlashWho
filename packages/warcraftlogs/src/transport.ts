/**
 * How the client reaches Warcraft Logs: the client-credentials token, the
 * GraphQL request, and how an HTTP status or error envelope becomes a
 * limitation. It knows nothing about characters, reports or rankings.
 */
import {
  classifyResponse,
  createClientCredentialsTokenSource,
  isUpstreamFailure,
  nonEmptyString,
  record,
  type ThrottleObserver,
  type UpstreamFailure
} from "@slashwho/upstream-http";

import type { WarcraftLogsLimitation } from "./types";

export type GraphqlSuccess = Readonly<{ kind: "success"; value: unknown }>;
export type GraphqlResult = GraphqlSuccess | WarcraftLogsLimitation;

/**
 * Reads an upstream failure as the limitation this client reports. A
 * `Retry-After` rides along whatever the status, so a 503 that says when to
 * come back is waited out as long as upstream asked, like a 429.
 */
function failureLimitation(failure: UpstreamFailure): WarcraftLogsLimitation {
  switch (failure.kind) {
    case "not_found":
      return { kind: "limitation", code: "not_found" };
    case "forbidden":
      return { kind: "limitation", code: "private" };
    case "schema_drift":
      return { kind: "limitation", code: "schema_drift" };
    case "transient":
      return {
        kind: "limitation",
        code: failure.status === 429 ? "rate_limited" : "unavailable",
        ...(failure.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: failure.retryAfterMs })
      };
  }
}

// Only 403 speaks for the thing asked about. A 401 is our token being
// refused, which says nothing about the character, and reads as
// `unavailable` (#563).
function responseLimitation(
  response: Response,
  onThrottle?: ThrottleObserver
): WarcraftLogsLimitation {
  return failureLimitation(classifyResponse(response, onThrottle));
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
    onThrottle?: ThrottleObserver;
  }>
): WarcraftLogsTransport {
  const baseUrl = options.baseUrl;
  const tokens = createClientCredentialsTokenSource({
    provider: "warcraftlogs",
    fetch: options.fetch,
    url: new URL("/oauth/token", baseUrl ?? "https://www.warcraftlogs.com"),
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    onThrottle: options.onThrottle
  });

  function graphqlUrl(): URL {
    return new URL("/api/v2/client", baseUrl ?? "https://www.warcraftlogs.com");
  }

  // The token endpoint answers for our credentials, never for a character, so
  // the source never reports `not_found` or `forbidden` (#563). A caller's
  // own abort is not an upstream failure, and still throws.
  async function accessToken(
    signal?: AbortSignal
  ): Promise<string | WarcraftLogsLimitation> {
    try {
      return await tokens.token(signal);
    } catch (error) {
      if (!isUpstreamFailure(error)) throw error;
      return failureLimitation(error);
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
      tokens.invalidate(token);
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
        signal: signal ?? null
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "limitation", code: "unavailable" };
    }

    signal?.throwIfAborted();
    if (response.status === 401) return rejected();
    if (!response.ok) return responseLimitation(response, options.onThrottle);
    try {
      const body: unknown = await response.json();
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
