import {
  parseEncryptionKey,
  parseNegativeCacheTtlMs
} from "@slashwho/application";

export type WorkerConfig = {
  databaseUrl: string;
  healthHost: "127.0.0.1" | "0.0.0.0";
  port: number;
  workerDrainTimeoutMs: number;
  workerAbortGraceMs: number;
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
  evidenceCapRetryMs: number;
  evidenceTransientRetryMs: number;
  evidenceResumeSweepLimit: number;
  evidenceFreshnessHours: number;
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
    // How much of the drain budget a still-running job may spend finishing
    // before its signal is aborted (#306). Observed evidence runs take 199-591
    // seconds, so almost nothing falls in the band this cuts short, and the
    // handler's abort path needs only the one write that releases the run. This
    // is the tuning knob if run durations ever shorten.
    workerAbortGraceMs: integerInRange(
      environment.WORKER_ABORT_GRACE_MS,
      5_000,
      0,
      600_000,
      "invalid_worker_abort_grace"
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
    // Pages of report history one run may scan. A ceiling, not the value a
    // run gets: `effectiveRequestCap` scales it to the allowance the run's own
    // credentials report and to whose credentials those are, so 500 is only
    // ever reached by an account large enough to afford it. At the worker's
    // 18000 the effective cap is 300; on a visitor's 3600 it is 18. See
    // MAXIMUM_SCAN_SHARE_OF_OWN_ALLOWANCE in
    // packages/application/src/applicant-evidence-job-handler.ts, which holds
    // the derivation and the arithmetic against EVIDENCE_POINTS_RESERVE.
    //
    // The scan buys most of a run's points -- 58-89% of spend, and all of the
    // variance -- so this is the knob that decides what a started run costs,
    // the way the reserve decides whether it starts. `requestCapUsed` in the
    // job record is the effective cap, not this number.
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
    // A run that spends one of its own request budgets has work outstanding
    // and no upstream retry hint to carry, so it supplies its own. Half an
    // hour matches the observed recovery of a rate-limited run, which resumed
    // and added parses without intervention; it saturates a ten-character
    // dossier in hours rather than days while the per-run budget still bounds
    // load.
    //
    // EVIDENCE_PARSE_CAP_RETRY_MS is the name this was deployed under while it
    // governed the parse cap alone. It is still read, because renaming a
    // variable an operator may have set on Railway would silently revert their
    // value to the default -- exactly the divergence the note above warns of.
    evidenceCapRetryMs: positiveInteger(
      environment.EVIDENCE_CAP_RETRY_MS ??
        environment.EVIDENCE_PARSE_CAP_RETRY_MS,
      30 * 60_000,
      "invalid_evidence_cap_retry_ms"
    ),
    // A run stopped by an unreachable upstream, or by throttling that carried
    // no Retry-After, waits this long instead of forever. Before this existed
    // those runs published no retry at all, which `isEvidenceFresh` reads as
    // "never": a transport blip stranded a character until someone bumped the
    // evidence version.
    //
    // Fifteen minutes is a guess, and a deliberately shorter one than the cap
    // delay: a cap means we stopped on purpose with a known amount left to
    // fetch, while an unavailable upstream may be back in a minute. The cost
    // of guessing low is one wasted request against a points allowance that
    // fully resets each hour.
    evidenceTransientRetryMs: positiveInteger(
      environment.EVIDENCE_TRANSIENT_RETRY_MS,
      15 * 60_000,
      "invalid_evidence_transient_retry_ms"
    ),
    // How many waiting characters one resume sweep may start. A tick runs
    // every five minutes and the queue collects one run at a time, so this
    // bounds the backlog a single tick can enqueue rather than the rate
    // anything is collected at -- the points gate still decides that.
    //
    // 25 is comfortably more than the ten-character sweeps seen so far, and
    // low enough that a table full of stranded characters drains over several
    // ticks instead of flooding the queue in one.
    evidenceResumeSweepLimit: positiveInteger(
      environment.EVIDENCE_RESUME_SWEEP_LIMIT,
      25,
      "invalid_evidence_resume_sweep_limit"
    ),
    // The same FRESHNESS_HOURS the web service reads, and the same default, so
    // a resume sweep asks `reserve` exactly the question a dossier read would.
    // A character the sweep picked up is past its retry deadline and so never
    // fresh whatever this is, but passing a value the read path does not share
    // would make the two able to disagree about a character neither of them
    // has a reason to disagree about.
    evidenceFreshnessHours: positiveInteger(
      environment.FRESHNESS_HOURS,
      24,
      "invalid_freshness_hours"
    ),
    // How much of the Warcraft Logs hourly allowance must remain before a run
    // is allowed to start.
    //
    // 5000 IS MEASURED, not guessed (#295). It replaces an earlier 1500, which
    // was inferred from ten runs exceeding 9000 points in total on 2026-09-17
    // -- an average above 900 and nothing about the spread.
    //
    // The measurement: 22 `pointsSpentByRun` deltas logged between 12:10 and
    // 15:10 on 2026-09-18, the first window in which they mean anything, since
    // #296 made runs serial and #293 stopped them failing before they collected
    // (a before/after delta charges overlapping runs to each other). Nineteen
    // of the 22 collected something; the other three read a character with
    // nothing to fetch and cost 2, 22 and 31 points.
    //
    // Across those nineteen: min 862, p25 1392, median 1609, p75 2216,
    // p90 3627, max 4775. Twelve of them cost more than the old 1500 reserve,
    // so admission was approving runs that could not finish more often than
    // not -- the exact failure the reserve exists to prevent. 5000 covers the
    // measured maximum.
    //
    // The spread is structural rather than noise: spend tracks request volume
    // at a steady 15-20 points each, and the history scan varies from 32 to 190
    // requests with how much history a character has. Expect a 5x range between
    // characters, not a tight cluster around the median.
    //
    // Two caveats a later reader should keep. Every collection in the sample
    // was truncated by `parse_request_cap`, so these are capped costs and an
    // uncapped run costs at least this much. And a configured value only
    // reaches the run through `effectiveReserve`, which caps it at a share of
    // the account's reported allowance -- see MAXIMUM_RESERVE_SHARE_OF_ALLOWANCE
    // in applicant-evidence-job-handler.ts, raised to 0.3 alongside this so
    // 5000 is not silently clipped to 1800.
    //
    // EVIDENCE_PARSE_REQUEST_CAP sat diverged between Railway (12) and code
    // (24) until 2026-09-17 precisely because nothing forced that review, so
    // this default and the Railway variable were set in the same change.
    //
    // That was not enough, and the reason is worth reading before trusting the
    // numbers above. Within an hour of 5000 landing, the parse cap reverted
    // from 48 to 24 -- correctly, once #314 fixed properly what the 48 had
    // worked around -- and the whole sample became a measurement of a
    // configuration that no longer ran. The same failure this paragraph
    // describes, one level up. The configuration the sample was taken under is
    // therefore also asserted, in apps/worker/src/evidence-run-budget.test.ts,
    // so the next such change fails CI instead of quietly expiring a constant
    // in another file. #295 stays open for a clean sample post-#331: the runs
    // above overlapped the repeated-work loop, so they bound a broken run
    // rather than measuring a healthy one, and post-revert costs top out
    // nearer 2900.
    // 0 switches the gate off, which is deliberate: an operator who finds it
    // refusing too much needs a lever that is not a code change and a redeploy.
    evidencePointsReserve: integerInRange(
      environment.EVIDENCE_POINTS_RESERVE,
      5_000,
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
