import {
  parseEncryptionKey,
  parseNegativeCacheTtlMs
} from "@slashwho/application";

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
  raiderIoAccessKey?: string;
  discoveryWebhookUrl?: string;
  blizzardClientId: string;
  blizzardClientSecret: string;
  warcraftLogsClientId: string;
  warcraftLogsClientSecret: string;
  evidenceRequestCap: number;
  evidenceParseRequestCap: number;
  evidenceParseCapRetryMs: number;
  evidencePointsReserve: number;
  evidenceKillSettleDays: number;
  evidenceRetryCostCeiling: number;
  evidenceFailureCooldownMs: number;
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

function optionalSecret(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
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
    // Shared with the dossier read path — see parseNegativeCacheTtlMs.
    negativeCacheTtlMs: parseNegativeCacheTtlMs(
      environment.NEGATIVE_CACHE_TTL_MS
    ),
    raiderIoBaseUrl:
      environment.RAIDER_IO_BASE_URL?.trim() || "https://raider.io",
    raiderIoTimeoutMs: positiveInteger(
      environment.RAIDER_IO_TIMEOUT_MS,
      10_000,
      "invalid_raiderio_timeout"
    ),
    raiderIoAccessKey: optionalSecret(environment.RAIDER_IO_ACCESS_KEY),
    discoveryWebhookUrl: optionalSecret(environment.DISCOVERY_WEBHOOK_URL),
    blizzardClientId,
    blizzardClientSecret,
    warcraftLogsClientId,
    warcraftLogsClientSecret,
    evidenceRequestCap: positiveInteger(
      environment.EVIDENCE_REQUEST_CAP,
      500,
      "invalid_evidence_request_cap"
    ),
    // One request hydrates a whole report, and hydration now spends the budget
    // on each boss's first kill starting from the current tier. 24 covers a
    // tier's first kills in a couple of runs while staying well clear of the
    // Warcraft Logs throttling seen at higher volumes; already-stored fights
    // are skipped, so successive runs advance rather than repeat.
    evidenceParseRequestCap: positiveInteger(
      environment.EVIDENCE_PARSE_REQUEST_CAP,
      24,
      "invalid_evidence_parse_request_cap"
    ),
    // A run that spends its whole parse budget has work outstanding and no
    // upstream retry hint to carry, so it supplies its own. Half an hour
    // matches the observed recovery of a rate-limited run, which resumed and
    // added parses without intervention; it saturates a ten-character dossier
    // in hours rather than days while the per-run budget still bounds load.
    evidenceParseCapRetryMs: positiveInteger(
      environment.EVIDENCE_PARSE_CAP_RETRY_MS,
      30 * 60_000,
      "invalid_evidence_parse_cap_retry_ms"
    ),
    // How much of the Warcraft Logs hourly allowance must remain before a run
    // is allowed to start.
    //
    // 1500 IS A GUESS. It is derived only from ten runs exceeding 9000 points
    // on 2026-09-17, so the average run costs more than 900; 1500 is that
    // floor plus headroom, picked so a run is refused rather than started and
    // abandoned part-way. The average says nothing about the distribution.
    // The `pointsSpentByRun` deltas the evidence job now logs are what replace
    // this guess with evidence -- revisit this within a day of the first
    // deployment. EVIDENCE_PARSE_REQUEST_CAP sat diverged between Railway (12)
    // and code (24) until 2026-09-17 precisely because nothing forced that
    // review.
    // 0 switches the gate off, which is deliberate: the value above is a guess,
    // and an operator who finds it refusing too much needs a lever that is not
    // a code change and a redeploy.
    evidencePointsReserve: integerInRange(
      environment.EVIDENCE_POINTS_RESERVE,
      1_500,
      0,
      Number.MAX_SAFE_INTEGER,
      "invalid_evidence_points_reserve"
    ),
    // Rankings are understood to settle a few days after a kill. A kill
    // younger than this is re-read rather than frozen, and its tier cannot go
    // terminal.
    //
    // Seven days is a guess and explicitly unverified. Two attempts to measure
    // it retrospectively failed, because comparing the committed snapshot
    // against live mixes genuine drift, a float-to-integer precision change,
    // and corrections from parse fixes the snapshot predates. The observation
    // times now stored alongside each percentile are what should replace it.
    // Setting it too low freezes a wrong percentile permanently -- 0 disables
    // the wait entirely and should only be used deliberately.
    evidenceKillSettleDays: integerInRange(
      environment.EVIDENCE_KILL_SETTLE_DAYS,
      7,
      0,
      365,
      "invalid_evidence_kill_settle_days"
    ),
    // Points above which a failed attempt is not retried, whatever kind of
    // fault it was. #292 charged one run five full collections for a single
    // deterministic throw: 1,180-2,523 points an attempt, ~8,600 in total,
    // nothing published.
    //
    // 250 IS A GUESS, of the same family as EVIDENCE_POINTS_RESERVE's. It sits
    // below a real collection (whose average the reserve's comment puts above
    // 900) and above the handful of requests an early failure makes, which is
    // all it has to do to tell "failed before doing the work" from "failed
    // after paying for it". The `pointsSpentByRun` deltas on the evidence job
    // record are what replace it with evidence -- revisit it against a week of
    // them. 0 switches the veto off, for an operator who finds it stopping
    // runs that a retry would have rescued.
    evidenceRetryCostCeiling: integerInRange(
      environment.EVIDENCE_RETRY_COST_CEILING,
      250,
      0,
      Number.MAX_SAFE_INTEGER,
      "invalid_evidence_retry_cost_ceiling"
    ),
    // How long a run that stopped on a fault waits before a reader may reserve
    // another. `failed` is invisible to `reserve` -- neither active nor
    // completed -- so without this a stopped run is re-reserved by the next
    // page read and a retry storm becomes a reservation storm. Half an hour
    // matches EVIDENCE_PARSE_CAP_RETRY_MS, and for the same reason: long
    // enough that a persistently broken character is not re-collected on every
    // read, short enough that it recovers without intervention.
    evidenceFailureCooldownMs: positiveInteger(
      environment.EVIDENCE_FAILURE_COOLDOWN_MS,
      30 * 60_000,
      "invalid_evidence_failure_cooldown_ms"
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
