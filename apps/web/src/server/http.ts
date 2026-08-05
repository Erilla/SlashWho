import type {
  CreateSearchResult,
  PublicReadAuthorizationResult
} from "@slashwho/application";
import {
  createSearchResponseSchema,
  publicErrorHttpStatus,
  safeApiErrorSchema,
  type PublicErrorCode
} from "@slashwho/contracts";
import { parseRaiderIoCharacterUrl, type CharacterKey } from "@slashwho/domain";
import { randomUUID } from "node:crypto";

import { webLogger } from "./logger";

const resourceCacheControl = "public, max-age=60, stale-while-revalidate=300";

const errorMessages: Record<PublicErrorCode, string> = {
  invalid_character_url: "The character URL is invalid.",
  character_not_found: "The character was not found.",
  rate_limited: "Too many requests.",
  upstream_unavailable: "Character data is temporarily unavailable.",
  search_failed: "The search could not be completed.",
  suppressed_character: "The character was not found.",
  unauthorized: "Authentication failed.",
  trusted_client_ip_unavailable: "The trusted client boundary is unavailable."
};

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
      error: { code, message: errorMessages[code] }
    }),
    { status: publicErrorHttpStatus[code], headers }
  );
}

export function createSearchHttpResponse(result: CreateSearchResult): Response {
  if (result.kind === "character") {
    return Response.json(
      createSearchResponseSchema.parse({
        kind: "character",
        character: result.character
      }),
      { headers: { "cache-control": "no-store" } }
    );
  }
  if (result.kind === "job") {
    const headers = new Headers({
      "cache-control": "no-store",
      location: result.statusUrl
    });
    if (result.staleCharacter) {
      return Response.json(
        createSearchResponseSchema.parse({
          kind: "character",
          character: result.staleCharacter
        }),
        { headers }
      );
    }
    return Response.json(
      createSearchResponseSchema.parse({
        kind: "job",
        jobId: result.jobId,
        status: result.status,
        statusUrl: result.statusUrl,
        characterUrl: result.characterUrl
      }),
      { status: 202, headers }
    );
  }
  if (result.kind === "rate_limited") {
    return apiError("rate_limited", {
      retryAfterSeconds: result.retryAfterSeconds
    });
  }
  return apiError(result.code);
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

export function publicResourceResponse(
  value: unknown,
  options: { authenticated?: boolean } = {}
): Response {
  return Response.json(value, {
    headers: {
      "cache-control": options.authenticated
        ? "private, no-store"
        : resourceCacheControl
    }
  });
}

export function jobStatusResponse(value: unknown): Response {
  return Response.json(value, {
    headers: { "cache-control": "no-store" }
  });
}

export function parseCharacterRoute(params: {
  region: string;
  realm: string;
  name: string;
}): { key: CharacterKey; canonical: boolean } {
  const key = parseRaiderIoCharacterUrl(
    `https://raider.io/characters/${encodeURIComponent(params.region)}/${encodeURIComponent(params.realm)}/${encodeURIComponent(params.name)}`
  );
  return {
    key,
    canonical:
      params.region === key.region &&
      params.realm === key.realm &&
      params.name === key.name
  };
}

export function canonicalApiCharacterPath(key: CharacterKey): string {
  return `/api/v1/characters/${key.region}/${key.realm}/${key.name}`;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value
  );
}

export function isHistoryCursor(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as { refreshedAt?: unknown; id?: unknown };
    return (
      typeof parsed.refreshedAt === "string" &&
      !Number.isNaN(new Date(parsed.refreshedAt).valueOf()) &&
      typeof parsed.id === "string" &&
      isUuid(parsed.id)
    );
  } catch {
    return false;
  }
}

type HttpLogger = {
  info(value: Record<string, unknown>): void;
};

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
  try {
    response = await action();
  } catch {
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
    ...(count === undefined ? {} : { count })
  });
  return response;
}
