import { expect, it } from "vitest";

import { loadWorkerConfig } from "./config";

const environment = {
  DATABASE_URL: "postgresql://slashwho:test@db/slashwho",
  BLIZZARD_CLIENT_ID: "worker-client-id",
  BLIZZARD_CLIENT_SECRET: "worker-client-secret",
  BLIZZARD_SWEEP_REQUEST_CAP: "300",
  WARCRAFT_LOGS_CLIENT_ID: "warcraft-logs-client-id",
  WARCRAFT_LOGS_CLIENT_SECRET: "warcraft-logs-client-secret",
  EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64)
};

it("keeps applicant polling disabled until credentials and limits are explicit", () => {
  expect(loadWorkerConfig(environment).applicantWatcher.enabled).toBe(false);
  expect(loadWorkerConfig(environment).applicantWatcher.column).toBe("F");
  expect(() =>
    loadWorkerConfig({ ...environment, APPLICANT_WATCHER_ENABLED: "true" })
  ).toThrow("applicant_watcher_configuration_required");
  expect(
    loadWorkerConfig({
      ...environment,
      APPLICANT_WATCHER_ENABLED: "true",
      APPLICANT_SHEET_ID: "fake-id",
      APPLICANT_GOOGLE_SERVICE_ACCOUNT_EMAIL: "fake@example.test",
      APPLICANT_GOOGLE_PRIVATE_KEY: "fake-key",
      MAINTAINER_ALERT_WEBHOOK_URL: "https://example.test/alert",
      APPLICANT_POLL_CADENCE_MS: "300000",
      APPLICANT_ADMISSIONS_PER_TICK: "1",
      APPLICANT_ADMISSIONS_PER_DAY: "5",
      APPLICANT_BACKLOG_LIMIT: "100",
      APPLICANT_QUEUE_DEPTH_LIMIT: "10",
      APPLICANT_MINIMUM_POINTS: "3500"
    }).applicantWatcher.enabled
  ).toBe(true);
});

it("accepts a Google Sheet URL and a configured response column", () => {
  expect(
    loadWorkerConfig({
      ...environment,
      APPLICANT_SHEET_URL:
        "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=0",
      APPLICANT_SHEET_COLUMN: " g "
    }).applicantWatcher
  ).toMatchObject({ sheetId: "sheet_123", column: "G" });
  expect(() =>
    loadWorkerConfig({ ...environment, APPLICANT_SHEET_COLUMN: "F:G" })
  ).toThrow("invalid_applicant_sheet_column");
  expect(() =>
    loadWorkerConfig({
      ...environment,
      APPLICANT_SHEET_URL: "https://example.test/spreadsheets/d/sheet_123"
    })
  ).toThrow("invalid_applicant_sheet_url");
  expect(() =>
    loadWorkerConfig({
      ...environment,
      APPLICANT_SHEET_ID: "sheet_123",
      APPLICANT_SHEET_URL:
        "https://docs.google.com/spreadsheets/d/sheet_123/edit"
    })
  ).toThrow("ambiguous_applicant_sheet_source");
});

it("rejects missing Blizzard credentials and invalid sweep bounds", () => {
  // Break caught: the worker could start a sweep without its private Blizzard
  // credentials or reserve an impossible number of upstream requests.
  expect(() =>
    loadWorkerConfig({ DATABASE_URL: environment.DATABASE_URL })
  ).toThrow("blizzard_client_id_required");
  expect(() =>
    loadWorkerConfig({ ...environment, BLIZZARD_SWEEP_REQUEST_CAP: "0" })
  ).toThrow("invalid_blizzard_sweep_request_cap");
  expect(() =>
    loadWorkerConfig({
      ...environment,
      FINGERPRINT_MINIMUM_IDENTICAL_PERCENT: "101"
    })
  ).toThrow("invalid_fingerprint_minimum_identical_percent");
  expect(() =>
    loadWorkerConfig({
      ...environment,
      BLIZZARD_SWEEP_REQUEST_CAP: "301",
      BLIZZARD_HOURLY_REQUEST_BUDGET: "300"
    })
  ).toThrow("invalid_blizzard_sweep_request_cap");
});

it("loads private Blizzard sweep defaults only for the worker", () => {
  // Break caught: an omitted operational limit could silently become unbounded
  // or make the planned seven-day sweep cadence depend on another process.
  expect(loadWorkerConfig(environment)).toMatchObject({
    blizzardClientId: environment.BLIZZARD_CLIENT_ID,
    blizzardClientSecret: environment.BLIZZARD_CLIENT_SECRET,
    blizzardSweepRequestCap: 300,
    blizzardHourlyRequestBudget: 28_800,
    fingerprintMinimumCommon: 200,
    fingerprintMinimumIdenticalPercent: 20,
    fingerprintSweepCadenceHours: 168
  });
});

it("requires worker-only Warcraft Logs credentials and a bounded evidence cap", () => {
  // Break caught: complete history collection could start without its private
  // credentials, or silently turn into an unbounded upstream scan.
  expect(() =>
    loadWorkerConfig({
      ...environment,
      WARCRAFT_LOGS_CLIENT_ID: undefined
    })
  ).toThrow("warcraft_logs_client_id_required");
  expect(() =>
    loadWorkerConfig({
      ...environment,
      WARCRAFT_LOGS_CLIENT_SECRET: undefined
    })
  ).toThrow("warcraft_logs_client_secret_required");
  expect(() =>
    loadWorkerConfig({ ...environment, EVIDENCE_REQUEST_CAP: "0" })
  ).toThrow("invalid_evidence_request_cap");
  expect(() =>
    loadWorkerConfig({ ...environment, EVIDENCE_PARSE_REQUEST_CAP: "0" })
  ).toThrow("invalid_evidence_parse_request_cap");
  expect(() =>
    loadWorkerConfig({ ...environment, EVIDENCE_TIER_SEARCH_REQUEST_CAP: "0" })
  ).toThrow("invalid_evidence_tier_search_request_cap");
  // Break caught: the reserve is an admitted guess to be revisited within a day
  // of deployment, and rejecting 0 at boot left a code change and a redeploy as
  // the only way to switch the gate off if the guess refuses too much.
  expect(
    loadWorkerConfig({ ...environment, EVIDENCE_POINTS_RESERVE: "0" })
  ).toMatchObject({ evidencePointsReserve: 0 });
  expect(() =>
    loadWorkerConfig({ ...environment, EVIDENCE_POINTS_RESERVE: "-1" })
  ).toThrow("invalid_evidence_points_reserve");
  // The settle period is another admitted guess, so 0 switches the wait off
  // without a redeploy. A negative one is nonsense rather than a lever.
  expect(
    loadWorkerConfig({ ...environment, EVIDENCE_KILL_SETTLE_DAYS: "0" })
  ).toMatchObject({ evidenceKillSettleDays: 0 });
  expect(() =>
    loadWorkerConfig({ ...environment, EVIDENCE_KILL_SETTLE_DAYS: "-1" })
  ).toThrow("invalid_evidence_kill_settle_days");
  expect(() =>
    loadWorkerConfig({ ...environment, EVIDENCE_KILL_SETTLE_DAYS: "1.5" })
  ).toThrow("invalid_evidence_kill_settle_days");

  // Break caught: the cost ceiling is a guess of the same family as the
  // reserve's, so an operator who finds it stopping runs a retry would have
  // rescued needs the same lever -- 0, rather than a code change.
  expect(
    loadWorkerConfig({ ...environment, EVIDENCE_RETRY_COST_CEILING: "0" })
  ).toMatchObject({ evidenceRetryCostCeiling: 0 });
  expect(() =>
    loadWorkerConfig({ ...environment, EVIDENCE_RETRY_COST_CEILING: "-1" })
  ).toThrow("invalid_evidence_retry_cost_ceiling");
  // The cooldown is what keeps a stopped run from being re-reserved by the next
  // page read, so unlike the ceiling it has no "off".
  expect(() =>
    loadWorkerConfig({ ...environment, EVIDENCE_FAILURE_COOLDOWN_MS: "0" })
  ).toThrow("invalid_evidence_failure_cooldown_ms");

  expect(loadWorkerConfig(environment)).toMatchObject({
    warcraftLogsClientId: environment.WARCRAFT_LOGS_CLIENT_ID,
    warcraftLogsClientSecret: environment.WARCRAFT_LOGS_CLIENT_SECRET,
    evidenceRequestCap: 500,
    evidenceParseRequestCap: 24,
    evidencePointsReserve: 3500,
    evidenceKillSettleDays: 7,
    evidenceRetryCostCeiling: 250,
    evidenceFailureCooldownMs: 1_800_000
  });
});

it("accepts a local Blizzard endpoint only when explicitly configured", () => {
  // Break caught: e2e could not direct its fake credentials and sweep requests
  // to its deterministic local fixture.
  expect(
    loadWorkerConfig({
      ...environment,
      BLIZZARD_BASE_URL: "http://127.0.0.1:43101"
    }).blizzardBaseUrl
  ).toBe("http://127.0.0.1:43101");
});

it("preserves a discovery webhook path and query string", () => {
  // Break caught: a Discord webhook's path is the whole credential, so any
  // normalisation that kept only the origin would post to discord.com itself.
  const webhookUrl =
    "https://discord.com/api/webhooks/000000000000000000/AbCdEf-token_value";

  expect(
    loadWorkerConfig({
      ...environment,
      DISCOVERY_WEBHOOK_URL: webhookUrl
    }).discoveryWebhookUrl
  ).toBe(webhookUrl);
});

it("preserves a maintainer webhook path and query string", () => {
  // Break caught: URL validation could reduce a provider webhook to its origin,
  // posting alerts to the provider homepage instead of the secret endpoint.
  const webhookUrl =
    "https://hooks.example.test/services/T000/B000/token?wait=true";

  expect(
    loadWorkerConfig({
      ...environment,
      MAINTAINER_ALERT_WEBHOOK_URL: webhookUrl
    }).maintainerAlertWebhookUrl
  ).toBe(webhookUrl);
});

it("throws when EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY is missing", () => {
  // Break caught: the worker could start without the key it needs to decrypt
  // a visitor-supplied WarcraftLogs credential from an evidence job.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY, ...rest } = environment;
  expect(() => loadWorkerConfig(rest)).toThrow(
    "evidence_job_credential_encryption_key_required"
  );
});

it("throws when EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY is malformed", () => {
  // Break caught: a truncated or non-hex key could pass through unvalidated
  // and fail unpredictably at encrypt/decrypt time instead of at startup.
  expect(() =>
    loadWorkerConfig({
      ...environment,
      EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY: "not-a-valid-key"
    })
  ).toThrow("invalid_credential_encryption_key");
});

it("accepts only explicit loopback or container health hosts", () => {
  // Break caught: a deploy could silently bind to an unusable or arbitrary
  // interface instead of the intended local/container health boundary.
  expect(
    loadWorkerConfig({
      ...environment,
      WORKER_HEALTH_HOST: "0.0.0.0"
    }).healthHost
  ).toBe("0.0.0.0");
  expect(() =>
    loadWorkerConfig({
      ...environment,
      WORKER_HEALTH_HOST: "public.example"
    })
  ).toThrow("invalid_worker_health_host");
});

it("keeps the shared negative-cache TTL behaving exactly as the worker's own did", () => {
  // Break caught: promoting NEGATIVE_CACHE_TTL_MS to shared configuration
  // could quietly change the worker's default or drop its validation.
  expect(loadWorkerConfig(environment)).toMatchObject({
    negativeCacheTtlMs: 300_000
  });
  expect(
    loadWorkerConfig({ ...environment, NEGATIVE_CACHE_TTL_MS: "60000" })
  ).toMatchObject({ negativeCacheTtlMs: 60_000 });
  expect(() =>
    loadWorkerConfig({ ...environment, NEGATIVE_CACHE_TTL_MS: "0" })
  ).toThrow("invalid_negative_cache_ttl");
});

it("reads an optional Raider.IO access key and trims it", () => {
  // Break caught: a configured server key could be ignored, leaving discovery
  // sweeps on the anonymous rate limit they were configured to escape.
  expect(
    loadWorkerConfig({ ...environment, RAIDER_IO_ACCESS_KEY: "  server-key  " })
      .raiderIoAccessKey
  ).toBe("server-key");
});

it("leaves the Raider.IO access key undefined when it is absent or blank", () => {
  // Break caught: an unset or whitespace-only key could become an empty string
  // and be sent as access_key=, breaking anonymous access for local dev and
  // contributors without a key.
  expect(loadWorkerConfig(environment).raiderIoAccessKey).toBeUndefined();
  expect(
    loadWorkerConfig({ ...environment, RAIDER_IO_ACCESS_KEY: "   " })
      .raiderIoAccessKey
  ).toBeUndefined();
});

it("reserves part of the drain budget for aborting work that cannot finish", () => {
  // Break caught: #306. Spending the whole budget waiting for evidence runs
  // that take minutes meant the handler's release path never ran on a deploy.
  // A grace of 0 is a valid setting -- abort at once -- so it must load.
  expect(loadWorkerConfig(environment)).toMatchObject({
    workerAbortGraceMs: 5_000
  });
  expect(
    loadWorkerConfig({ ...environment, WORKER_ABORT_GRACE_MS: "0" })
  ).toMatchObject({ workerAbortGraceMs: 0 });
  expect(() =>
    loadWorkerConfig({ ...environment, WORKER_ABORT_GRACE_MS: "-1" })
  ).toThrow("invalid_worker_abort_grace");
});
