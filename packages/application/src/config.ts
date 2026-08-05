import { z } from "zod";

/**
 * Only limits the web/application layer actually reads. Worker-owned operational
 * limits (the discovery request cap and the negative-cache TTL) are validated by
 * `loadWorkerConfig` in apps/worker so each limit has exactly one source of truth.
 */
export const applicationConfigSchema = z.object({
  BOT_API_KEY: z.string().min(32),
  RATE_LIMIT_HASH_SECRET: z.string().min(32),
  ANONYMOUS_SEARCHES_PER_HOUR: z.coerce.number().int().positive().default(10),
  BOT_SEARCHES_PER_HOUR: z.coerce.number().int().positive().default(60),
  PUBLIC_READS_PER_MINUTE: z.coerce.number().int().positive().default(300),
  FRESHNESS_HOURS: z.coerce.number().positive().default(24)
});

export type ApplicationConfig = z.infer<typeof applicationConfigSchema>;
