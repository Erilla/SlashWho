import { z } from "zod";

export const publicErrorCodeSchema = z.enum([
  "invalid_character_url",
  "character_not_found",
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
  rate_limited: 429,
  upstream_unavailable: 503,
  search_failed: 500,
  suppressed_character: 404,
  unauthorized: 401,
  trusted_client_ip_unavailable: 503
} as const satisfies Record<PublicErrorCode, number>;

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
