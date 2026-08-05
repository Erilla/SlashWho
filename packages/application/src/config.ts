import { z } from "zod";

export const applicationConfigSchema = z.object({
  BOT_API_KEY: z.string().min(32),
  RATE_LIMIT_HASH_SECRET: z.string().min(32),
  ANONYMOUS_SEARCHES_PER_HOUR: z.coerce.number().int().positive().default(10),
  BOT_SEARCHES_PER_HOUR: z.coerce.number().int().positive().default(60),
  PUBLIC_READS_PER_MINUTE: z.coerce.number().int().positive().default(300),
  FRESHNESS_HOURS: z.coerce.number().positive().default(24),
  NEGATIVE_CACHE_MINUTES: z.coerce.number().positive().default(15),
  DISCOVERY_REQUEST_CAP: z.coerce.number().int().positive().default(12)
});

export type ApplicationConfig = z.infer<typeof applicationConfigSchema>;
