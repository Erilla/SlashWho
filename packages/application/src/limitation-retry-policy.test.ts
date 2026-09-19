import type { WarcraftLogsLimitationCode } from "@slashwho/warcraftlogs";
import { describe, expect, it } from "vitest";

import {
  drivingParseLimitation,
  retryDelayMsFor
} from "./limitation-retry-policy";

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

  it("retries an unmatched ranking identity, which is not a decoding bug", () => {
    // Split from `parse_schema_drift` by #349. Sharing drift's classification
    // stalled 7 of 10 characters for a day the moment #346 stopped the parse
    // budget overwriting it.
    expect(delayFor("parse_identity_unmatched")).toBe(delays.transientRetryMs);
  });
});

describe("drivingParseLimitation", () => {
  const limitation = (code: WarcraftLogsLimitationCode) => ({ code });

  it("prefers a limitation that earns a retry over one that does not", () => {
    // Break caught: the whole reason the precedence is a rule rather than
    // assignment order. Keeping the first raised would let drift, which has
    // no retry, suppress the cap's -- trading a masking bug for a stall.
    expect(
      drivingParseLimitation(
        [limitation("parse_schema_drift"), limitation("parse_request_cap")],
        delays
      )
    ).toEqual(limitation("parse_request_cap"));
  });

  it("keeps the first raised when both earn a retry", () => {
    // The earlier failure is the more specific one, and either would
    // reschedule the character.
    expect(
      drivingParseLimitation(
        [
          limitation("parse_identity_unmatched"),
          limitation("parse_request_cap")
        ],
        delays
      )
    ).toEqual(limitation("parse_identity_unmatched"));
  });

  it("keeps the first raised when none earns a retry", () => {
    expect(
      drivingParseLimitation(
        [limitation("parse_schema_drift"), limitation("parse_private")],
        delays
      )
    ).toEqual(limitation("parse_schema_drift"));
  });

  it("honours an upstream Retry-After over the code's own classification", () => {
    // Drift has no retry of its own, but upstream asking us to wait is a
    // retry, and upstream knows better than a default.
    expect(
      drivingParseLimitation(
        [
          { code: "parse_schema_drift" as const, retryAfterMs: 1_000 },
          limitation("parse_request_cap")
        ],
        delays
      )
    ).toEqual({ code: "parse_schema_drift", retryAfterMs: 1_000 });
  });

  it("has nothing to drive when the run raised nothing", () => {
    expect(drivingParseLimitation([], delays)).toBeUndefined();
  });
});
