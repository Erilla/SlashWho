import {
  integerInRange,
  loadSharedConfig,
  optionalHttpUrl,
  optionalSecret,
  positiveInteger,
  requiredPositiveInteger,
  requiredSecret,
  type Environment
} from "@slashwho/application";
import type { AccountMailConfig } from "./account-mail";

export type WorkerConfig = {
  applicantWatcher: {
    enabled: boolean;
    sheetId?: string;
    column: string;
    dossierBaseUrl?: string;
    apiKey?: string;
    serviceAccountEmail?: string;
    privateKey?: string;
    cadenceMs: number;
    perTick: number;
    perDay: number;
    backlog: number;
    queueDepth: number;
    minimumPoints: number;
  };
  accountMail?: AccountMailConfig;
  accountCredentialEncryptionKey?: Buffer;
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
  evidenceTierSearchRequestCap: number;
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

function applicantSheetId(environment: Environment): string | undefined {
  const id = optionalSecret(environment.APPLICANT_SHEET_ID);
  const value = optionalSecret(environment.APPLICANT_SHEET_URL);
  if (!value) return id;
  if (id) throw new Error("ambiguous_applicant_sheet_source");
  try {
    const url = new URL(value);
    const match = /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/.*)?$/.exec(
      url.pathname
    );
    if (
      url.protocol !== "https:" ||
      url.hostname !== "docs.google.com" ||
      !match
    )
      throw new Error();
    return match[1];
  } catch {
    throw new Error("invalid_applicant_sheet_url");
  }
}

function applicantSheetColumn(value: string | undefined): string {
  const column = value === undefined ? "F" : value.trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(column))
    throw new Error("invalid_applicant_sheet_column");
  return column;
}

function applicantDossierOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error("invalid_applicant_dossier_base_url");
  }
}

export function loadWorkerConfig(
  environment: Environment = process.env
): WorkerConfig {
  const shared = loadSharedConfig(environment);
  const resendApiKey = optionalSecret(environment.RESEND_API_KEY);
  const accountEmailFrom = optionalSecret(environment.ACCOUNT_EMAIL_FROM);
  const accountKey = shared.accountCredentialEncryptionKey;
  // Saved account keys may be enabled without delivery on this process.
  let accountMail: AccountMailConfig | undefined;
  if (resendApiKey || accountEmailFrom) {
    if (!resendApiKey || !accountEmailFrom || !accountKey) {
      throw new Error("account_mail_configuration_incomplete");
    }
    accountMail = {
      resendApiKey,
      accountEmailFrom,
      accountCredentialEncryptionKey: accountKey
    };
  }
  const applicantEnabled = environment.APPLICANT_WATCHER_ENABLED === "true";
  if (
    environment.APPLICANT_WATCHER_ENABLED &&
    !["true", "false"].includes(environment.APPLICANT_WATCHER_ENABLED)
  )
    throw new Error("invalid_applicant_watcher_enabled");
  const applicantWatcher = {
    enabled: applicantEnabled,
    sheetId: applicantSheetId(environment),
    column: applicantSheetColumn(environment.APPLICANT_SHEET_COLUMN),
    dossierBaseUrl: applicantDossierOrigin(
      environment.APPLICANT_DOSSIER_BASE_URL
    ),
    apiKey: optionalSecret(environment.APPLICANT_GOOGLE_API_KEY),
    serviceAccountEmail: optionalSecret(
      environment.APPLICANT_GOOGLE_SERVICE_ACCOUNT_EMAIL
    ),
    privateKey: optionalSecret(
      environment.APPLICANT_GOOGLE_PRIVATE_KEY
    )?.replace(/\\n/g, "\n"),
    cadenceMs: integerInRange(
      environment.APPLICANT_POLL_CADENCE_MS,
      300_000,
      300_000,
      3_600_000,
      "invalid_applicant_poll_cadence"
    ),
    perTick: integerInRange(
      environment.APPLICANT_ADMISSIONS_PER_TICK,
      1,
      1,
      20,
      "invalid_applicant_per_tick"
    ),
    perDay: integerInRange(
      environment.APPLICANT_ADMISSIONS_PER_DAY,
      5,
      1,
      100,
      "invalid_applicant_per_day"
    ),
    backlog: integerInRange(
      environment.APPLICANT_BACKLOG_LIMIT,
      100,
      1,
      1_000,
      "invalid_applicant_backlog"
    ),
    queueDepth: integerInRange(
      environment.APPLICANT_QUEUE_DEPTH_LIMIT,
      10,
      1,
      100,
      "invalid_applicant_queue_depth"
    ),
    minimumPoints: integerInRange(
      environment.APPLICANT_MINIMUM_POINTS,
      3500,
      1,
      100_000,
      "invalid_applicant_minimum_points"
    )
  };
  if (
    applicantWatcher.apiKey &&
    (applicantWatcher.serviceAccountEmail || applicantWatcher.privateKey)
  )
    throw new Error("ambiguous_applicant_google_credentials");
  if (
    applicantEnabled &&
    (!applicantWatcher.sheetId ||
      (!applicantWatcher.apiKey &&
        (!applicantWatcher.serviceAccountEmail ||
          !applicantWatcher.privateKey)) ||
      !environment.MAINTAINER_ALERT_WEBHOOK_URL ||
      !environment.APPLICANT_POLL_CADENCE_MS ||
      !environment.APPLICANT_ADMISSIONS_PER_TICK ||
      !environment.APPLICANT_ADMISSIONS_PER_DAY ||
      !environment.APPLICANT_BACKLOG_LIMIT ||
      !environment.APPLICANT_QUEUE_DEPTH_LIMIT ||
      !environment.APPLICANT_MINIMUM_POINTS)
  )
    throw new Error("applicant_watcher_configuration_required");
  const healthHost = environment.WORKER_HEALTH_HOST ?? "127.0.0.1";
  if (healthHost !== "127.0.0.1" && healthHost !== "0.0.0.0") {
    throw new Error("invalid_worker_health_host");
  }
  const warcraftLogsClientId = requiredSecret(
    environment.WARCRAFT_LOGS_CLIENT_ID,
    "warcraft_logs_client_id_required"
  );
  const warcraftLogsClientSecret = requiredSecret(
    environment.WARCRAFT_LOGS_CLIENT_SECRET,
    "warcraft_logs_client_secret_required"
  );
  // No default: every deployment sets the per-cycle cap explicitly, and a
  // missing one says so rather than reporting an invalid value (#569).
  const blizzardSweepRequestCap = requiredPositiveInteger(
    environment.BLIZZARD_SWEEP_REQUEST_CAP,
    "blizzard_sweep_request_cap_required",
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
    applicantWatcher,
    ...(accountMail ? { accountMail } : {}),
    ...(accountKey ? { accountCredentialEncryptionKey: accountKey } : {}),
    databaseUrl: shared.databaseUrl,
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
    negativeCacheTtlMs: shared.negativeCacheTtlMs,
    raiderIoBaseUrl: shared.raiderIoBaseUrl,
    raiderIoTimeoutMs: shared.raiderIoTimeoutMs,
    raiderIoAccessKey: shared.raiderIoAccessKey,
    discoveryWebhookUrl: optionalSecret(environment.DISCOVERY_WEBHOOK_URL),
    blizzardClientId: shared.blizzardClientId,
    blizzardClientSecret: shared.blizzardClientSecret,
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
    // The most requests one "search this tier" may make (#435): attendance
    // pages at about 28 points each and hydrated reports at about 2 (#538).
    // It is carved out of the run's scan cap, never added to it, so the run's
    // points budget is the one `evidenceRunBudget` already guards.
    evidenceTierSearchRequestCap: positiveInteger(
      environment.EVIDENCE_TIER_SEARCH_REQUEST_CAP,
      60,
      "invalid_evidence_tier_search_request_cap"
    ),
    // A run that spends one of its own request budgets has work outstanding
    // and no upstream retry hint to carry, so it supplies its own. Half an
    // hour matches the observed recovery of a rate-limited run, which resumed
    // and added parses without intervention; it saturates a ten-character
    // dossier in hours rather than days while the per-run budget still bounds
    // load.
    //
    // A shorter delay buys cadence only while the hourly points allowance has
    // room, because the reserve gate refuses any re-entry that arrives before
    // it does. Measured on `test` from 2026-09-19 to 2026-09-25, under a
    // temporary 20-minute override (#345). On 2026-09-22 and 23 the gate
    // refused 234 of 310 cap retries (75%). Those days spent 262k and 195k
    // points, 61% and 45% of the worker's 432k daily allowance (18,000 an
    // hour), so the saturation was hourly, not daily. In the hours with five
    // or more refusals, the worker's own runs spent 12.5k-19.6k points against
    // the 14,500 usable above the 3,500 reserve, and every refused run opened
    // with less than the reserve left. Once the backlog had drained, on
    // 2026-09-24 and 25, all 16 cap retries went through. So 20 minutes saves
    // ten minutes per capped step when load is light. Under load it mostly
    // creates refusals, each costing a probe point, a queue attempt and
    // another wait. It is not the default because light load is also when the
    // extra cadence matters least.
    //
    // The sample passed two of evidence-run-cost.md's checks and failed one.
    // Passed: no row's hourly window moved, and the unmeasured rows are
    // exactly the refused attempts, which spend nothing. Failed: twelve
    // handovers on 22-23 carry unaccounted spend of up to 1,753 points. That
    // spend is outside the totals above and only adds to the load, so it
    // strengthens the hourly binding rather than explaining it.
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
    // The same FRESHNESS_HOURS the web service reads, through the same parser
    // (parseFreshnessHours) and so the same default, so a resume sweep asks `reserve` exactly the question a dossier read would.
    // A character the sweep picked up is past its retry deadline and so never
    // fresh whatever this is, but passing a value the read path does not share
    // would make the two able to disagree about a character neither of them
    // has a reason to disagree about.
    evidenceFreshnessHours: shared.freshnessHours,
    // How much of the Warcraft Logs hourly allowance must remain before a run
    // is allowed to start.
    //
    // 3500 IS MEASURED, not guessed (#295). Two earlier values sit behind it:
    // 1500, inferred from ten runs exceeding 9000 points in total on
    // 2026-09-17 -- an average above 900 and nothing about the spread -- and
    // 5000, measured but at a parse cap that no longer exists (see below).
    //
    // The measurement: eight `pointsSpentByRun` deltas logged between 22:15
    // and 22:56 on 2026-09-18, two full cycles of four characters with no
    // looping and no failures, at the code-default parse cap of 24.
    //
    //   814  820  1092  1092  1495  1633  2888  2906
    //
    // max 2906, mean 1593, 12741 points across the hour. 3500 covers the
    // maximum with about 600 points to spare.
    //
    // The deltas only mean anything because three things had landed: #296 made
    // runs serial (a before/after delta charges overlapping runs to each
    // other), #293 stopped them failing before they collected, and #331 stopped
    // four characters repeating identical work. Samples taken before #331 bound
    // the cost of a broken run rather than measuring a healthy one, which is
    // why the earlier 4775 maximum is not in this file any more.
    //
    // The spread is structural rather than noise: spend tracks request volume,
    // and the history scan varies with how much history a character has -- a
    // 66-page scan is ~1320 points before a single parse. Expect a 3-4x range
    // between characters, not a tight cluster around the mean.
    //
    // Why lower rather than leave the margin. The reserve is the binding
    // constraint on run rate, and the arithmetic is exact: 18000 - 5000 = 13000
    // usable, over a 1593 mean, is 8.2 runs an hour, and eight is what was
    // observed. At 3500 it is 14500 / 1593 = 9.1. Holding 5000 reserves enough
    // for a run that cannot happen, at a cost of roughly three runs a window.
    //
    // A configured value only reaches the run through `effectiveReserve`, which
    // caps it at MAXIMUM_RESERVE_SHARE_OF_ALLOWANCE of the account's reported
    // allowance -- see applicant-evidence-job-handler.ts. That share stays at
    // 0.3: on the worker's 18000 the ceiling is 5400, so 3500 applies in full,
    // and on a visitor's 3600 the ceiling is 1080, which already bound below
    // both the old value and this one, so visitor behaviour is unchanged.
    //
    // Two values before this one went stale unnoticed, and the shape was the
    // same both times. EVIDENCE_PARSE_REQUEST_CAP sat diverged between Railway
    // (12) and code (24) until 2026-09-17 because nothing forced the review; a
    // Railway copy of this variable was deleted on 2026-09-18 for the same
    // reason. Then, within an hour of 5000 landing, the parse cap reverted from
    // 48 to 24 -- correctly, once #314 fixed properly what the 48 had worked
    // around -- and the sample behind 5000 became a measurement of a
    // deployment that no longer ran. Nothing failed. The configuration this
    // sample was taken under is therefore asserted in
    // apps/worker/src/evidence-run-budget.test.ts, which expires the
    // measurement when the parse cap or the effective scan depth moves. If it
    // fails, re-measure: do not edit the recorded sample to match.
    //
    // Re-measuring is a query now, not an archaeology exercise. Per-run spend
    // is persisted to character_evidence_run_costs alongside the caps it was
    // spent under, and docs/operations/evidence-run-cost.md has the query that
    // returns the distribution -- and the two checks that say whether the
    // sample was contaminated before you set anything from it (#342).
    // 0 switches the gate off, which is deliberate: an operator who finds it
    // refusing too much needs a lever that is not a code change and a redeploy.
    evidencePointsReserve: integerInRange(
      environment.EVIDENCE_POINTS_RESERVE,
      3_500,
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
    // page read and a retry storm becomes a reservation storm. Half an hour is
    // long enough that a persistently broken character is not re-collected on
    // every read, and short enough that it recovers without intervention. It
    // equals EVIDENCE_CAP_RETRY_MS's default only by coincidence. The two are
    // independent, and changing one does not call for changing the other.
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
    fingerprintSweepCadenceHours: shared.fingerprintSweepCadenceHours,
    maintainerAlertWebhookUrl: optionalHttpUrl(
      environment.MAINTAINER_ALERT_WEBHOOK_URL,
      "invalid_maintainer_alert_webhook_url"
    ),
    evidenceJobCredentialEncryptionKey:
      shared.evidenceJobCredentialEncryptionKey
  };
}
