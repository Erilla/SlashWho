import { z } from "zod";

/**
 * How long a failed upstream lookup is remembered, by the worker's persisted
 * negative cache and by the read path's in-process one alike. That is one
 * operational limit, not two, so it is defined here once and consumed by both
 * `loadWorkerConfig` and `applicationConfigSchema` below.
 */
export const NEGATIVE_CACHE_TTL_DEFAULT_MS = 300_000;

export function parseNegativeCacheTtlMs(value: string | undefined): number {
  const parsed =
    value === undefined ? NEGATIVE_CACHE_TTL_DEFAULT_MS : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("invalid_negative_cache_ttl");
  }
  return parsed;
}

/**
 * Only limits the web/application layer actually reads. Worker-owned operational
 * limits (the discovery request cap) are validated by `loadWorkerConfig` in
 * apps/worker so each limit has exactly one source of truth.
 */
export const applicationConfigSchema = z.object({
  BOT_API_KEY: z.string().min(32),
  RATE_LIMIT_HASH_SECRET: z.string().min(32),
  ANONYMOUS_SEARCHES_PER_HOUR: z.coerce.number().int().positive().default(10),
  BOT_SEARCHES_PER_HOUR: z.coerce.number().int().positive().default(60),
  PUBLIC_READS_PER_MINUTE: z.coerce.number().int().positive().default(300),
  FRESHNESS_HOURS: z.coerce.number().positive().default(24),
  FINGERPRINT_SWEEP_CADENCE_HOURS: z.coerce.number().positive().default(168),
  DOSSIER_CHARACTER_CAP: z.coerce.number().int().min(1).max(30).default(12),
  DOSSIER_PROVIDER_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(12)
    .default(4),
  NEGATIVE_CACHE_TTL_MS: z
    .string()
    .optional()
    .transform(parseNegativeCacheTtlMs)
});

export type ApplicationConfig = z.infer<typeof applicationConfigSchema>;
