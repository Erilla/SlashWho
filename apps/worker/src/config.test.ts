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

  expect(loadWorkerConfig(environment)).toMatchObject({
    warcraftLogsClientId: environment.WARCRAFT_LOGS_CLIENT_ID,
    warcraftLogsClientSecret: environment.WARCRAFT_LOGS_CLIENT_SECRET,
    evidenceRequestCap: 500,
    evidenceParseRequestCap: 24
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
