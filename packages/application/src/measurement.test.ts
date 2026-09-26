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

  it("names the slowest of durations measured elsewhere", () => {
    // Break caught: a request timed inside an upstream client reaches the
    // scope only as a number, so the scope's own `time` cannot name it.
    const scope = createMeasurementScope(fakeClock([0]));

    scope.observeSlowest("warcraftLogsMaxRequest", 120, "history_scan");
    scope.observeSlowest("warcraftLogsMaxRequest", 480, "guild_attendance");
    scope.observeSlowest("warcraftLogsMaxRequest", 480, "fight_parses");
    scope.observeSlowest("warcraftLogsMaxRequest", 90, "zone_rankings");

    expect(scope.totals()).toEqual({
      warcraftLogsMaxRequestMs: 480,
      warcraftLogsMaxRequestName: "guild_attendance"
    });
  });

  it("names a slowest duration of zero", () => {
    // Break caught: seeding the maximum at zero would leave an instant first
    // request unnamed, and a name-less maximum points at nothing.
    const scope = createMeasurementScope(fakeClock([0]));

    scope.observeSlowest("warcraftLogsMaxRequest", 0, "history_scan");

    expect(scope.totals()).toEqual({
      warcraftLogsMaxRequestMs: 0,
      warcraftLogsMaxRequestName: "history_scan"
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
  describe("with overlapping calls shared", () => {
    function controlledClock() {
      let now = 0;
      return {
        monotonic: () => now,
        set(value: number) {
          now = value;
        }
      };
    }

    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => (resolve = done));
      return { promise, resolve };
    }

    it("splits overlapping time between the calls in progress", async () => {
      // Break caught: overlapping calls each charging their whole duration,
      // so the buckets add up to more wall time than the scope spanned.
      const clock = controlledClock();
      const scope = createMeasurementScope(clock.monotonic, {
        overlapping: "shared"
      });
      const first = deferred();
      const second = deferred();

      const a = scope.time("blizzard", () => first.promise);
      clock.set(10);
      const b = scope.time("db", () => second.promise);
      clock.set(30);
      first.resolve();
      await a;
      clock.set(40);
      second.resolve();
      await b;

      // 0-10 blizzard alone, 10-30 shared, 30-40 db alone.
      expect(scope.totals()).toMatchObject({
        blizzardMs: 20,
        blizzardCallMs: 30,
        blizzardCalls: 1,
        blizzardMaxCallMs: 30,
        dbMs: 20,
        dbCallMs: 30,
        dbCalls: 1
      });
    });

    it("charges an excluded region to whatever else is in progress, not the enclosing call", async () => {
      // Break caught: a budget write nested in a provider call counted in both
      // buckets, or left uncharged while the call it paused was still open.
      const clock = controlledClock();
      const scope = createMeasurementScope(clock.monotonic, {
        overlapping: "shared"
      });

      await scope.time("blizzard", async (excluded) => {
        clock.set(10);
        await excluded(async () => {
          await scope.time("db", async () => {
            clock.set(25);
          });
        });
        clock.set(30);
      });

      expect(scope.totals()).toMatchObject({
        blizzardMs: 15,
        blizzardCallMs: 15,
        dbMs: 15
      });
    });

    it("never reports more than the wall time, whatever the rounding", async () => {
      // Break caught: rounding each fractional share up letting many small
      // overlapping calls add up past the time they were split from.
      const clock = controlledClock();
      const scope = createMeasurementScope(clock.monotonic, {
        overlapping: "shared"
      });
      const gates = Array.from({ length: 3 }, deferred);
      const calls = gates.map((gate) =>
        scope.time("blizzard", () => gate.promise)
      );
      clock.set(1);
      for (const gate of gates) gate.resolve();
      await Promise.all(calls);

      expect(scope.totals().blizzardMs).toBeLessThanOrEqual(1);
    });

    it("reads the same as the summed default when calls never overlap", async () => {
      const summed = createMeasurementScope(fakeClock([0, 10, 10, 40]));
      const shared = createMeasurementScope(fakeClock([0, 10, 10, 40]), {
        overlapping: "shared"
      });

      for (const scope of [summed, shared]) {
        await scope.time("raiderIo", async () => "first");
        await scope.time("raiderIo", async () => "second");
      }

      expect(shared.totals()).toMatchObject({
        raiderIoMs: summed.totals().raiderIoMs,
        raiderIoCalls: 2,
        raiderIoMaxCallMs: 30
      });
    });
  });
});
