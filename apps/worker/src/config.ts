import { parseEncryptionKey } from "@slashwho/application";

export type WorkerConfig = {
  databaseUrl: string;
  healthHost: "127.0.0.1" | "0.0.0.0";
  port: number;
  workerDrainTimeoutMs: number;
  databaseStartupAttempts: number;
  databaseStartupRetryMs: number;
  discoveryRequestCap: number;
  negativeCacheTtlMs: number;
  raiderIoBaseUrl: string;
  raiderIoTimeoutMs: number;
  blizzardClientId: string;
  blizzardClientSecret: string;
  warcraftLogsClientId: string;
  warcraftLogsClientSecret: string;
  evidenceRequestCap: number;
  evidenceParseRequestCap: number;
  blizzardBaseUrl?: string;
  blizzardSweepRequestCap: number;
  blizzardHourlyRequestBudget: number;
  fingerprintMinimumCommon: number;
  fingerprintMinimumIdenticalPercent: number;
  fingerprintSweepCadenceHours: number;
  maintainerAlertWebhookUrl?: string;
  evidenceJobCredentialEncryptionKey: Buffer;
};

function positiveInteger(
  value: string | undefined,
  fallback: number,
  code: string
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

function integerInRange(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(code);
  }
  return parsed;
}

function requiredString(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new Error(code);
  return value;
}

function optionalHttpUrl(
  value: string | undefined,
  code: string
): string | undefined {
  if (value === undefined) return undefined;
  try {
    const normalized = value.trim();
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error();
    return normalized;
  } catch {
    throw new Error(code);
  }
}

export function loadWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env
): WorkerConfig {
  if (!environment.DATABASE_URL) throw new Error("database_url_required");
  const healthHost = environment.WORKER_HEALTH_HOST ?? "127.0.0.1";
  if (healthHost !== "127.0.0.1" && healthHost !== "0.0.0.0") {
    throw new Error("invalid_worker_health_host");
  }
  const blizzardClientId = requiredString(
    environment.BLIZZARD_CLIENT_ID,
    "blizzard_client_id_required"
  );
  const blizzardClientSecret = requiredString(
    environment.BLIZZARD_CLIENT_SECRET,
    "blizzard_client_secret_required"
  );
  const warcraftLogsClientId = requiredString(
    environment.WARCRAFT_LOGS_CLIENT_ID,
    "warcraft_logs_client_id_required"
  );
  const warcraftLogsClientSecret = requiredString(
    environment.WARCRAFT_LOGS_CLIENT_SECRET,
    "warcraft_logs_client_secret_required"
  );
  const blizzardSweepRequestCap = positiveInteger(
    environment.BLIZZARD_SWEEP_REQUEST_CAP,
    0,
    "invalid_blizzard_sweep_request_cap"
  );
  const blizzardHourlyRequestBudget = positiveInteger(
    environment.BLIZZARD_HOURLY_REQUEST_BUDGET,
    28_800,
    "invalid_blizzard_hourly_request_budget"
  );
  if (blizzardSweepRequestCap > blizzardHourlyRequestBudget) {
    throw new Error("invalid_blizzard_sweep_request_cap");
  }
  const evidenceJobCredentialEncryptionKey = (() => {
    const secret = environment.EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY?.trim();
    if (!secret) {
      throw new Error("evidence_job_credential_encryption_key_required");
    }
    return parseEncryptionKey(secret);
  })();

  return {
    databaseUrl: environment.DATABASE_URL,
    healthHost,
    port: positiveInteger(environment.PORT, 3001, "invalid_port"),
    workerDrainTimeoutMs: positiveInteger(
      environment.WORKER_DRAIN_TIMEOUT_MS,
      30_000,
      "invalid_worker_drain_timeout"
    ),
    databaseStartupAttempts: positiveInteger(
      environment.DATABASE_STARTUP_ATTEMPTS,
      5,
      "invalid_database_startup_attempts"
    ),
    databaseStartupRetryMs: positiveInteger(
      environment.DATABASE_STARTUP_RETRY_MS,
      1_000,
      "invalid_database_startup_retry"
    ),
    // A sweep spends one request per character to read its guild, on top of the
    // root and owner-profile lookups the relationship walk needs. At 12 a
    // wide account exhausted the budget and published a partial snapshot.
    discoveryRequestCap: positiveInteger(
      environment.DISCOVERY_REQUEST_CAP,
      40,
      "invalid_discovery_request_cap"
    ),
    negativeCacheTtlMs: positiveInteger(
      environment.NEGATIVE_CACHE_TTL_MS,
      300_000,
      "invalid_negative_cache_ttl"
    ),
    raiderIoBaseUrl:
      environment.RAIDER_IO_BASE_URL?.trim() || "https://raider.io",
    raiderIoTimeoutMs: positiveInteger(
      environment.RAIDER_IO_TIMEOUT_MS,
      10_000,
      "invalid_raiderio_timeout"
    ),
    blizzardClientId,
    blizzardClientSecret,
    warcraftLogsClientId,
    warcraftLogsClientSecret,
    evidenceRequestCap: positiveInteger(
      environment.EVIDENCE_REQUEST_CAP,
      500,
      "invalid_evidence_request_cap"
    ),
    evidenceParseRequestCap: positiveInteger(
      environment.EVIDENCE_PARSE_REQUEST_CAP,
      8,
      "invalid_evidence_parse_request_cap"
    ),
    blizzardBaseUrl: optionalHttpUrl(
      environment.BLIZZARD_BASE_URL,
      "invalid_blizzard_base_url"
    ),
    blizzardSweepRequestCap,
    blizzardHourlyRequestBudget,
    fingerprintMinimumCommon: positiveInteger(
      environment.FINGERPRINT_MINIMUM_COMMON,
      200,
      "invalid_fingerprint_minimum_common"
    ),
    fingerprintMinimumIdenticalPercent: integerInRange(
      environment.FINGERPRINT_MINIMUM_IDENTICAL_PERCENT,
      20,
      1,
      100,
      "invalid_fingerprint_minimum_identical_percent"
    ),
    fingerprintSweepCadenceHours: positiveInteger(
      environment.FINGERPRINT_SWEEP_CADENCE_HOURS,
      168,
      "invalid_fingerprint_sweep_cadence_hours"
    ),
    maintainerAlertWebhookUrl: optionalHttpUrl(
      environment.MAINTAINER_ALERT_WEBHOOK_URL,
      "invalid_maintainer_alert_webhook_url"
    ),
    evidenceJobCredentialEncryptionKey
  };
}
