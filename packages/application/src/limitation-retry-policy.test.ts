import type { WarcraftLogsLimitationCode } from "@slashwho/warcraftlogs";
import { describe, expect, it } from "vitest";

import { retryDelayMsFor } from "./limitation-retry-policy";

const delays = { transientRetryMs: 15 * 60_000, capRetryMs: 30 * 60_000 };

function delayFor(code: WarcraftLogsLimitationCode) {
  return retryDelayMsFor(code, delays);
}

describe("retryDelayMsFor", () => {
  it("gives an upstream transport failure a retry", () => {
    expect(delayFor("unavailable")).toBe(delays.transientRetryMs);
    expect(delayFor("parse_unavailable")).toBe(delays.transientRetryMs);
  });

  it("gives a throttled run a retry when upstream sent no hint", () => {
    expect(delayFor("rate_limited")).toBe(delays.transientRetryMs);
    expect(delayFor("parse_rate_limited")).toBe(delays.transientRetryMs);
  });

  it("gives a run that spent its own budget the cap delay", () => {
    expect(delayFor("request_cap")).toBe(delays.capRetryMs);
    expect(delayFor("parse_request_cap")).toBe(delays.capRetryMs);
  });

  it("leaves a character with no public logs alone", () => {
    expect(delayFor("not_found")).toBeNull();
    expect(delayFor("private")).toBeNull();
    expect(delayFor("parse_private")).toBeNull();
  });

  it("leaves drift alone, because waiting does not fix a decoding bug", () => {
    expect(delayFor("schema_drift")).toBeNull();
    expect(delayFor("parse_schema_drift")).toBeNull();
  });

  it("does not retry a budget refusal, which never publishes", () => {
    expect(delayFor("points_budget_low")).toBeNull();
  });
});
