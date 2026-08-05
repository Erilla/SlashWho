import { expect, it } from "vitest";

import { loadWorkerConfig } from "./config";

it("accepts only explicit loopback or container health hosts", () => {
  // Break caught: a deploy could silently bind to an unusable or arbitrary
  // interface instead of the intended local/container health boundary.
  expect(
    loadWorkerConfig({
      DATABASE_URL: "postgresql://slashwho:test@db/slashwho",
      WORKER_HEALTH_HOST: "0.0.0.0"
    }).healthHost
  ).toBe("0.0.0.0");
  expect(() =>
    loadWorkerConfig({
      DATABASE_URL: "postgresql://slashwho:test@db/slashwho",
      WORKER_HEALTH_HOST: "public.example"
    })
  ).toThrow("invalid_worker_health_host");
});
