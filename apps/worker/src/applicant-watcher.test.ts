import { describe, expect, it } from "vitest";
import { isApplicantPollDue } from "./applicant-watcher";

describe("isApplicantPollDue", () => {
  const minute = 60_000;
  const last = new Date("2026-10-13T12:00:00.000Z");
  const at = (ms: number) => last.getTime() + ms;

  it("polls a tick that starts a little before a full cadence has passed", () => {
    // Break caught: last_polled_at was stamped after the read, so a tick that
    // started a few hundred ms early skipped a whole period, and a five-minute
    // cadence polled every ten.
    expect(
      isApplicantPollDue({
        now: at(minute - 800),
        lastPolledAt: last,
        nextAttemptAt: 0,
        cadenceMs: minute
      })
    ).toBe(true);
  });

  it("does not poll twice inside one cadence", () => {
    expect(
      isApplicantPollDue({
        now: at(minute - 15_001),
        lastPolledAt: last,
        nextAttemptAt: 0,
        cadenceMs: minute
      })
    ).toBe(false);
  });

  it("polls when nothing has been polled yet", () => {
    expect(
      isApplicantPollDue({
        now: at(0),
        lastPolledAt: null,
        nextAttemptAt: 0,
        cadenceMs: minute
      })
    ).toBe(true);
  });

  it("waits out a failure back-off even when the cadence has passed", () => {
    expect(
      isApplicantPollDue({
        now: at(10 * minute),
        lastPolledAt: last,
        nextAttemptAt: at(11 * minute),
        cadenceMs: minute
      })
    ).toBe(false);
  });

  it("allows a tick a few seconds before the back-off deadline", () => {
    // Break caught: the back-off compared with no tolerance, so a retry whose
    // tick started 10 s early slipped a whole extra minute.
    expect(
      isApplicantPollDue({
        now: at(11 * minute - 10_000),
        lastPolledAt: last,
        nextAttemptAt: at(11 * minute),
        cadenceMs: minute
      })
    ).toBe(true);
    expect(
      isApplicantPollDue({
        now: at(11 * minute - 16_000),
        lastPolledAt: last,
        nextAttemptAt: at(11 * minute),
        cadenceMs: minute
      })
    ).toBe(false);
  });

  it("reads last_polled_at as the string pg may return", () => {
    expect(
      isApplicantPollDue({
        now: at(minute),
        lastPolledAt: last.toISOString(),
        nextAttemptAt: 0,
        cadenceMs: minute
      })
    ).toBe(true);
  });
});
