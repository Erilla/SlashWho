import { z } from "zod";

import {
  optionalEncryptionKey,
  optionalSecret,
  parseDatabaseUrl,
  positiveInteger,
  positiveNumber,
  requiredEncryptionKey,
  requiredSecret,
  type Environment
} from "./environment";

/**
 * How long a failed upstream lookup is remembered, by the worker's persisted
 * negative cache and by the read path's in-process one alike. That is one
 * operational limit, not two, so it is defined here once and consumed by both
 * `loadSharedConfig` and `applicationConfigSchema` below.
 */
export const NEGATIVE_CACHE_TTL_DEFAULT_MS = 300_000;

export function parseNegativeCacheTtlMs(value: string | undefined): number {
  return positiveInteger(
    value,
    NEGATIVE_CACHE_TTL_DEFAULT_MS,
    "invalid_negative_cache_ttl"
  );
}

/**
 * How long collected evidence stays fresh. The web asks it of a dossier read
 * and the worker of a resume sweep, so the two must agree about the same
 * character. Hours need not be whole: the web has always accepted 1.5, and
 * the worker once crashed on it (#569).
 */
export function parseFreshnessHours(value: string | undefined): number {
  return positiveNumber(value, 24, "invalid_freshness_hours");
}

/**
 * How long after a sweep another fingerprint sweep is due. A search schedules
 * it on the web and a discovery run admits it on the worker.
 */
export function parseFingerprintSweepCadenceHours(
  value: string | undefined
): number {
  return positiveNumber(value, 168, "invalid_fingerprint_sweep_cadence_hours");
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
  // Per caller, on top of the once-a-day limit on each character's tier: a
  // search spends the worker's Warcraft Logs allowance, so one caller cannot
  // walk every tier of every character in an hour (#435).
  TIER_SEARCHES_PER_HOUR: z.coerce.number().int().positive().default(6),
  // Shared with the worker -- see loadSharedConfig.
  FRESHNESS_HOURS: z.string().optional().transform(parseFreshnessHours),
  FINGERPRINT_SWEEP_CADENCE_HOURS: z
    .string()
    .optional()
    .transform(parseFingerprintSweepCadenceHours),
  // A backstop against a pathological roster, not a display cap: every
  // included character is researched and listed up to it (#555). The largest
  // real roster was 23 when this was set; Warcraft Logs cost is paced by the
  // points allowance and the queue, not by how many characters a dossier has.
  // Renamed from DOSSIER_CHARACTER_CAP so a deployment still setting the old
  // limit of 12 stops applying it rather than silently keeping it.
  DOSSIER_CHARACTER_CEILING: z.coerce
    .number()
    .int()
    .min(1)
    // Held to the tier search's per-press limit by its test, so a press
    // always reaches every listed character.
    .max(50)
    .default(50),
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

/**
 * The keys both services read. Each app keeps only its own keys; these are
 * parsed here once, so one environment cannot boot one service and crash the
 * other, or give the two different values (#569). The web additionally
 * surfaces FRESHNESS_HOURS, FINGERPRINT_SWEEP_CADENCE_HOURS and
 * NEGATIVE_CACHE_TTL_MS through `applicationConfigSchema`, with the same
 * parsers.
 */
export type SharedConfig = Readonly<{
  databaseUrl: string;
  raiderIoBaseUrl: string;
  raiderIoTimeoutMs: number;
  raiderIoAccessKey?: string;
  blizzardClientId: string;
  blizzardClientSecret: string;
  freshnessHours: number;
  fingerprintSweepCadenceHours: number;
  negativeCacheTtlMs: number;
  evidenceJobCredentialEncryptionKey: Buffer;
  accountCredentialEncryptionKey?: Buffer;
}>;

export function loadSharedConfig(environment: Environment): SharedConfig {
  const databaseUrl = parseDatabaseUrl(environment.DATABASE_URL);
  const blizzardClientId = requiredSecret(
    environment.BLIZZARD_CLIENT_ID,
    "blizzard_client_id_required"
  );
  const blizzardClientSecret = requiredSecret(
    environment.BLIZZARD_CLIENT_SECRET,
    "blizzard_client_secret_required"
  );
  const evidenceJobCredentialEncryptionKey = requiredEncryptionKey(
    environment.EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY,
    "evidence_job_credential_encryption_key_required"
  );
  const accountCredentialEncryptionKey = optionalEncryptionKey(
    environment.ACCOUNT_CREDENTIAL_ENCRYPTION_KEY
  );
  if (
    accountCredentialEncryptionKey?.equals(evidenceJobCredentialEncryptionKey)
  )
    throw new Error("account_credential_encryption_key_must_be_distinct");
  const raiderIoAccessKey = optionalSecret(environment.RAIDER_IO_ACCESS_KEY);
  return {
    databaseUrl,
    raiderIoBaseUrl:
      optionalSecret(environment.RAIDER_IO_BASE_URL) ?? "https://raider.io",
    raiderIoTimeoutMs: positiveInteger(
      environment.RAIDER_IO_TIMEOUT_MS,
      10_000,
      "invalid_raider_io_timeout_ms"
    ),
    ...(raiderIoAccessKey ? { raiderIoAccessKey } : {}),
    blizzardClientId,
    blizzardClientSecret,
    freshnessHours: parseFreshnessHours(environment.FRESHNESS_HOURS),
    fingerprintSweepCadenceHours: parseFingerprintSweepCadenceHours(
      environment.FINGERPRINT_SWEEP_CADENCE_HOURS
    ),
    negativeCacheTtlMs: parseNegativeCacheTtlMs(
      environment.NEGATIVE_CACHE_TTL_MS
    ),
    evidenceJobCredentialEncryptionKey,
    ...(accountCredentialEncryptionKey
      ? { accountCredentialEncryptionKey }
      : {})
  };
}
