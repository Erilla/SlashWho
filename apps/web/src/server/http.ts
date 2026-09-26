import {
  attributeThrottlesTo,
  createMeasurementScope,
  type MeasurementScope,
  type PublicReadAuthorizationResult
} from "@slashwho/application";
import {
  publicErrorHttpStatus,
  publicErrorMessages,
  safeApiErrorSchema,
  type PublicErrorCode
} from "@slashwho/contracts";
import { parseRaiderIoCharacterUrl, type CharacterKey } from "@slashwho/domain";
import { randomUUID } from "node:crypto";

import { errorName } from "./error-name";
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

function publicResponseCount(body: string): number | undefined {
  let value: Record<string, unknown> | null;
  try {
    value = JSON.parse(body) as Record<string, unknown> | null;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
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

/**
 * Reads a JSON response's body once and returns a fresh response carrying it,
 * so the count can be taken without `clone()`. Node's bundled undici registers
 * a clone's finaliser against the original's tee branch, so collecting a
 * discarded clone cancels the body the caller has yet to read.
 */
async function countedResponse(
  response: Response
): Promise<{ response: Response; count: number | undefined }> {
  if (
    response.body === null ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    return { response, count: undefined };
  }
  const body = await response.text();
  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    }),
    count: publicResponseCount(body)
  };
}

export async function withHttpRequest(
  endpoint: string,
  action: (scope: MeasurementScope, correlationId: string) => Promise<Response>,
  logger: HttpLogger = webLogger,
  clock: () => number = performance.now.bind(performance)
): Promise<Response> {
  const correlationId = randomUUID();
  const scope = createMeasurementScope(clock);
  const startedAt = clock();
  let response: Response;
  let failure: string | undefined;
  try {
    response = await attributeThrottlesTo(scope, { correlationId }, () =>
      action(scope, correlationId)
    );
  } catch (error) {
    failure = errorName(error);
    response = apiError("search_failed");
  }
  response.headers.set("x-request-id", correlationId);
  let count: number | undefined;
  try {
    ({ response, count } = await countedResponse(response));
  } catch (error) {
    failure ??= errorName(error);
    response = apiError("search_failed");
    response.headers.set("x-request-id", correlationId);
  }
  logger.info({
    event: "http_request",
    correlationId,
    endpoint,
    status: response.status,
    durationMs: Math.max(0, Math.round(clock() - startedAt)),
    ...scope.totals(),
    ...(count === undefined ? {} : { count }),
    ...(failure === undefined ? {} : { errorName: failure })
  });
  return response;
}
