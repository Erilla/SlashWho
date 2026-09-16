import { describe, expect, it } from "vitest";

import { createMeasurementScope } from "./measurement";

function fakeClock(steps: readonly number[]): () => number {
  let index = 0;
  return () => steps[Math.min(index++, steps.length - 1)]!;
}

describe("createMeasurementScope", () => {
  it("accumulates duration, call count, and longest call per prefix", async () => {
    const scope = createMeasurementScope(fakeClock([0, 10, 10, 40]));

    await scope.time("raiderIo", async () => "first");
    await scope.time("raiderIo", async () => "second");

    expect(scope.totals()).toMatchObject({
      raiderIoMs: 40,
      raiderIoCalls: 2,
      raiderIoMaxCallMs: 30
    });
  });

  it("names the labelled call that produced the longest duration", async () => {
    const scope = createMeasurementScope(fakeClock([0, 10, 10, 40, 40, 45]));

    await scope.time("db", async () => undefined, "snapshots.getCurrent");
    await scope.time("db", async () => undefined, "rankings.listForRealm");
    await scope.time("db", async () => undefined, "snapshots.create");

    expect(scope.totals()).toMatchObject({
      dbMaxCallMs: 30,
      dbMaxCallName: "rankings.listForRealm"
    });
  });

  it("keeps the name of the longest call when a later call is equally long", async () => {
    const scope = createMeasurementScope(fakeClock([0, 10, 10, 20]));

    await scope.time("db", async () => undefined, "snapshots.getCurrent");
    await scope.time("db", async () => undefined, "snapshots.create");

    expect(scope.totals()).toMatchObject({
      dbMaxCallMs: 10,
      dbMaxCallName: "snapshots.getCurrent"
    });
  });

  it("names a labelled call that throws", async () => {
    const scope = createMeasurementScope(fakeClock([0, 25]));

    await expect(
      scope.time(
        "db",
        async () => {
          throw new Error("connection_lost");
        },
        "snapshots.getCurrent"
      )
    ).rejects.toThrow("connection_lost");

    expect(scope.totals()).toMatchObject({
      dbMaxCallMs: 25,
      dbMaxCallName: "snapshots.getCurrent"
    });
  });

  it("emits no name for an unlabelled prefix", async () => {
    const scope = createMeasurementScope(fakeClock([0, 10]));

    await scope.time("blizzard", async () => undefined);

    expect(scope.totals()).not.toHaveProperty("blizzardMaxCallName");
  });

  it("records the duration of a call that throws", async () => {
    const scope = createMeasurementScope(fakeClock([0, 25]));

    await expect(
      scope.time("blizzard", async () => {
        throw new Error("upstream_timeout");
      })
    ).rejects.toThrow("upstream_timeout");

    expect(scope.totals()).toMatchObject({
      blizzardMs: 25,
      blizzardCalls: 1,
      blizzardMaxCallMs: 25
    });
  });

  it("returns the work's resolved value unchanged", async () => {
    const scope = createMeasurementScope(fakeClock([0, 1]));
    await expect(scope.time("db", async () => ({ rows: 3 }))).resolves.toEqual({
      rows: 3
    });
  });

  it("keeps prefixes disjoint", async () => {
    const scope = createMeasurementScope(fakeClock([0, 5, 5, 9]));

    await scope.time("db", async () => undefined);
    await scope.time("warcraftLogs", async () => undefined);

    expect(scope.totals()).toMatchObject({
      dbMs: 5,
      dbCalls: 1,
      warcraftLogsMs: 4,
      warcraftLogsCalls: 1
    });
  });

  it("accumulates observed, maximum, and incremented fields", () => {
    const scope = createMeasurementScope(fakeClock([0]));

    scope.observe("limiterWaitMs", 12);
    scope.observe("limiterWaitMs", 8);
    scope.increment("rateLimitHits");
    scope.increment("rateLimitHits");
    scope.observeMax("retryAfterMaxMs", 1_000);
    scope.observeMax("retryAfterMaxMs", 250);

    expect(scope.totals()).toEqual({
      limiterWaitMs: 20,
      rateLimitHits: 2,
      retryAfterMaxMs: 1_000
    });
  });

  it("marks a boolean flag", () => {
    const scope = createMeasurementScope(fakeClock([0]));
    scope.mark("runJoined");
    expect(scope.totals()).toEqual({ runJoined: true });
  });

  it("omits fields that were never touched", () => {
    expect(createMeasurementScope(fakeClock([0])).totals()).toEqual({});
  });

  it("rounds to whole milliseconds and never reports a negative duration", async () => {
    const scope = createMeasurementScope(fakeClock([10.6, 10.2]));
    await scope.time("db", async () => undefined);
    expect(scope.totals().dbMs).toBe(0);
  });
});
