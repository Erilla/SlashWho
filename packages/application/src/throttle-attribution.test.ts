import { describe, expect, it } from "vitest";

import { createMeasurementScope, type MeasurementScope } from "./measurement";
import {
  attributeThrottlesTo,
  bindThrottleScope,
  throttleFields,
  upstreamThrottleRecord,
  type ThrottleUnit
} from "./throttle-attribution";

/** Opens `unit` and binds `scope` to it, as a dispatcher and handler do. */
function asUnit<T>(
  unit: ThrottleUnit,
  scope: MeasurementScope,
  work: () => Promise<T>
): Promise<T> {
  return attributeThrottlesTo(unit, async () => {
    bindThrottleScope(scope);
    return work();
  });
}

describe("throttle attribution", () => {
  it("counts a throttle on the enclosing unit and names it on the line", async () => {
    const scope = createMeasurementScope(() => 0);

    const line = await asUnit({ runId: "run-1" }, scope, async () => {
      upstreamThrottleRecord("warcraftlogs", { retryAfterMs: 2_000 });
      return upstreamThrottleRecord("warcraftlogs", { retryAfterMs: 500 });
    });

    expect(scope.totals()).toEqual({
      warcraftLogsThrottles: 2,
      warcraftLogsRetryAfterMaxMs: 2_000
    });
    expect(line).toEqual({
      event: "upstream_throttle",
      provider: "warcraftlogs",
      retryAfterMs: 500,
      runId: "run-1"
    });
  });

  it("counts a throttle without Retry-After but records no delay", async () => {
    const scope = createMeasurementScope(() => 0);

    await asUnit({ correlationId: "c-1" }, scope, async () => {
      upstreamThrottleRecord("raiderio", { retryAfterMs: undefined });
    });

    expect(scope.totals()).toEqual({ raiderIoThrottles: 1 });
  });

  it("keeps concurrent units apart", async () => {
    // Break caught: a process-wide "current scope" would charge both
    // throttles to whichever unit bound last.
    const first = createMeasurementScope(() => 0);
    const second = createMeasurementScope(() => 0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const firstRun = asUnit({ correlationId: "first" }, first, async () => {
      await gate;
      return upstreamThrottleRecord("blizzard", { retryAfterMs: 100 });
    });
    const secondRun = asUnit({ correlationId: "second" }, second, async () =>
      upstreamThrottleRecord("raiderio", { retryAfterMs: 300 })
    );
    release();

    expect(await firstRun).toMatchObject({ correlationId: "first" });
    expect(await secondRun).toMatchObject({ correlationId: "second" });
    expect(first.totals()).toEqual({
      blizzardThrottles: 1,
      blizzardRetryAfterMaxMs: 100
    });
    expect(second.totals()).toEqual({
      raiderIoThrottles: 1,
      raiderIoRetryAfterMaxMs: 300
    });
  });

  it("attributes to the innermost unit", async () => {
    const outer = createMeasurementScope(() => 0);
    const inner = createMeasurementScope(() => 0);

    await asUnit({ correlationId: "outer" }, outer, () =>
      asUnit({ runId: "inner" }, inner, async () => {
        upstreamThrottleRecord("blizzard", { retryAfterMs: undefined });
      })
    );

    expect(outer.totals()).toEqual({});
    expect(inner.totals()).toEqual({ blizzardThrottles: 1 });
  });

  it("names a unit that has not bound a scope yet, counting nothing", async () => {
    // A throttle can arrive between the dispatcher opening the unit and the
    // handler creating its scope; the line must still say whose it was.
    const line = await attributeThrottlesTo({ runId: "run-2" }, async () =>
      upstreamThrottleRecord("blizzard", { retryAfterMs: 1_000 })
    );

    expect(line).toMatchObject({ runId: "run-2" });
  });

  it("ignores a bind outside any unit", async () => {
    const scope = createMeasurementScope(() => 0);

    bindThrottleScope(scope);
    upstreamThrottleRecord("blizzard", { retryAfterMs: 1_000 });

    expect(scope.totals()).toEqual({});
  });

  it("still produces a line, without an id, outside any unit", () => {
    expect(upstreamThrottleRecord("blizzard", { retryAfterMs: 1_000 })).toEqual(
      {
        event: "upstream_throttle",
        provider: "blizzard",
        retryAfterMs: 1_000
      }
    );
  });

  it("lists every field it can write", async () => {
    const scope = createMeasurementScope(() => 0);
    await asUnit({ runId: "run" }, scope, async () => {
      for (const provider of [
        "raiderio",
        "blizzard",
        "warcraftlogs"
      ] as const) {
        upstreamThrottleRecord(provider, { retryAfterMs: 1 });
      }
    });

    expect(Object.keys(scope.totals()).sort()).toEqual(
      [...throttleFields].sort()
    );
  });
});
