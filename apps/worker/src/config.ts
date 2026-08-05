export type WorkerConfig = {
  databaseUrl: string;
  port: number;
  workerDrainTimeoutMs: number;
  databaseStartupAttempts: number;
  databaseStartupRetryMs: number;
  discoveryRequestCap: number;
  negativeCacheTtlMs: number;
  raiderIoBaseUrl: string;
  raiderIoTimeoutMs: number;
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

export function loadWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env
): WorkerConfig {
  if (!environment.DATABASE_URL) throw new Error("database_url_required");

  return {
    databaseUrl: environment.DATABASE_URL,
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
    )
  };
}
