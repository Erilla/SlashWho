import { z } from "zod";

export const publicErrorCodeSchema = z.enum([
  "invalid_character_url",
  "character_not_found",
  "connection_not_found",
  "discovery_not_ready",
  "rate_limited",
  "upstream_unavailable",
  "search_failed",
  "suppressed_character",
  "unauthorized",
  "trusted_client_ip_unavailable"
]);

export type PublicErrorCode = z.infer<typeof publicErrorCodeSchema>;

export const publicErrorHttpStatus = {
  invalid_character_url: 400,
  character_not_found: 404,
  connection_not_found: 404,
  discovery_not_ready: 409,
  rate_limited: 429,
  upstream_unavailable: 503,
  search_failed: 500,
  suppressed_character: 404,
  unauthorized: 401,
  trusted_client_ip_unavailable: 503
} as const satisfies Record<PublicErrorCode, number>;

/**
 * The single public message per error code. Every adapter — HTTP mappers and
 * persisted job records alike — reads this table so one code can never surface
 * two different messages.
 */
export const publicErrorMessages = {
  invalid_character_url: "The character URL is invalid.",
  character_not_found: "The character was not found.",
  connection_not_found: "The character is no longer linked to this dossier.",
  discovery_not_ready: "Discovery is still in progress.",
  rate_limited: "Too many requests.",
  upstream_unavailable: "Character data is temporarily unavailable.",
  search_failed: "The search could not be completed.",
  suppressed_character: "The character was not found.",
  unauthorized: "Authentication failed.",
  trusted_client_ip_unavailable: "The trusted client boundary is unavailable."
} as const satisfies Record<PublicErrorCode, string>;

export const safeErrorDetailSchema = z
  .object({
    code: publicErrorCodeSchema,
    message: z.string().min(1)
  })
  .strict();

export const safeApiErrorSchema = z
  .object({
    error: safeErrorDetailSchema
  })
  .strict();

export type SafeErrorDetail = z.infer<typeof safeErrorDetailSchema>;
export type SafeApiError = z.infer<typeof safeApiErrorSchema>;
