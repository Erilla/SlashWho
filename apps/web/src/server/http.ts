import type { PublicReadAuthorizationResult } from "@slashwho/application";
import {
  publicErrorHttpStatus,
  publicErrorMessages,
  safeApiErrorSchema,
  type PublicErrorCode
} from "@slashwho/contracts";
import { parseRaiderIoCharacterUrl, type CharacterKey } from "@slashwho/domain";
import { randomUUID } from "node:crypto";

import { webLogger } from "./logger";

export function apiError(
  code: PublicErrorCode,
  options: { retryAfterSeconds?: number } = {}
): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (options.retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(options.retryAfterSeconds));
  }
  return Response.json(
    safeApiErrorSchema.parse({
      error: { code, message: publicErrorMessages[code] }
    }),
    { status: publicErrorHttpStatus[code], headers }
  );
}

export function publicReadAuthorizationResponse(
  result: PublicReadAuthorizationResult
): Response | null {
  if (result.allowed) return null;
  if ("retryAfterSeconds" in result) {
    return apiError("rate_limited", {
      retryAfterSeconds: result.retryAfterSeconds
    });
  }
  return apiError(result.code);
}

export function parseCharacterRoute(params: {
  region: string;
  realm: string;
  name: string;
}): { key: CharacterKey; canonical: boolean } {
  let decoded: { region: string; realm: string; name: string };
  try {
    decoded = {
      region: decodeURIComponent(params.region),
      realm: decodeURIComponent(params.realm),
      name: decodeURIComponent(params.name)
    };
  } catch {
    throw new Error("invalid_character_url");
  }
  const key = parseRaiderIoCharacterUrl(
    `https://raider.io/characters/${encodeURIComponent(decoded.region)}/${encodeURIComponent(decoded.realm)}/${encodeURIComponent(decoded.name)}`
  );
  return {
    key,
    canonical:
      decoded.region === key.region &&
      decoded.realm === key.realm &&
      decoded.name === key.name
  };
}

type HttpLogger = {
  info(value: Record<string, unknown>): void;
};

/**
 * The error's class name, reduced to identifier characters and bounded in length.
 * Never its message, the request URL, the request body, or an upstream payload.
 */
function errorName(error: unknown): string {
  const raw =
    error instanceof Error
      ? (error.constructor?.name ?? error.name)
      : typeof error;
  return raw.replaceAll(/[^A-Za-z0-9_]/g, "").slice(0, 64) || "unknown";
}

async function publicResponseCount(
  response: Response
): Promise<number | undefined> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    return undefined;
  }
  const value = (await response
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  if (!value) return undefined;
  const character = value.kind === "character" ? value.character : value;
  if (typeof character === "object" && character !== null) {
    const snapshot = (character as Record<string, unknown>).snapshot;
    if (typeof snapshot === "object" && snapshot !== null) {
      const count = (snapshot as Record<string, unknown>).characterCount;
      if (typeof count === "number") return count;
    }
  }
  if (Array.isArray(value.items)) return value.items.length;
  if (Array.isArray(value.characters)) return value.characters.length;
  return undefined;
}

export async function withHttpRequest(
  endpoint: string,
  action: () => Promise<Response>,
  logger: HttpLogger = webLogger,
  clock: () => number = performance.now.bind(performance)
): Promise<Response> {
  const correlationId = randomUUID();
  const startedAt = clock();
  let response: Response;
  let failure: string | undefined;
  try {
    response = await action();
  } catch (error) {
    failure = errorName(error);
    response = apiError("search_failed");
  }
  response.headers.set("x-request-id", correlationId);
  const count = await publicResponseCount(response);
  logger.info({
    event: "http_request",
    correlationId,
    endpoint,
    status: response.status,
    durationMs: Math.max(0, Math.round(clock() - startedAt)),
    ...(count === undefined ? {} : { count }),
    ...(failure === undefined ? {} : { errorName: failure })
  });
  return response;
}
