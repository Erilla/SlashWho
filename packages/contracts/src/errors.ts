import { z } from "zod";

export const publicErrorCodeSchema = z.enum([
  "invalid_character_url",
  "character_not_found",
  "rate_limited",
  "upstream_unavailable",
  "search_failed",
  "suppressed_character"
]);

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

export type PublicErrorCode = z.infer<typeof publicErrorCodeSchema>;
export type SafeErrorDetail = z.infer<typeof safeErrorDetailSchema>;
export type SafeApiError = z.infer<typeof safeApiErrorSchema>;
