import { expect, it } from "vitest";

import { loadWorkerConfig } from "./config";

const environment = {
  DATABASE_URL: "postgresql://slashwho:test@db/slashwho",
  BLIZZARD_CLIENT_ID: "worker-client-id",
  BLIZZARD_CLIENT_SECRET: "worker-client-secret",
  BLIZZARD_SWEEP_REQUEST_CAP: "300"
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
