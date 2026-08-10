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
  blizzardBaseUrl?: string;
  blizzardSweepRequestCap: number;
  blizzardHourlyRequestBudget: number;
  fingerprintMinimumCommon: number;
  fingerprintMinimumIdenticalPercent: number;
  fingerprintSweepCadenceHours: number;
  maintainerAlertWebhookUrl?: string;
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
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error();
    return url.origin;
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
    discoveryRequestCap: positiveInteger(
      environment.DISCOVERY_REQUEST_CAP,
      12,
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
    )
  };
}
