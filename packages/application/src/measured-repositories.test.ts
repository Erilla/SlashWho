import { describe, expect, it, vi } from "vitest";

import { createMeasurementScope } from "./measurement";
import { measuredRepositories } from "./measured-repositories";

function clock(steps: readonly number[]): () => number {
  let index = 0;
  return () => steps[Math.min(index++, steps.length - 1)]!;
}

describe("measuredRepositories", () => {
  it("times each repository call under the db prefix", async () => {
    const scope = createMeasurementScope(clock([0, 5, 5, 20]));
    const repositories = {
      snapshots: {
        getCurrent: async () => ({ id: "s1" }),
        create: async () => undefined
      }
    };

    const measured = measuredRepositories(repositories, scope);
    await measured.snapshots.getCurrent();
    await measured.snapshots.create();

    expect(scope.totals()).toMatchObject({
      dbMs: 20,
      dbCalls: 2,
      dbMaxCallMs: 15
    });
  });

  it("names the repository call that produced the longest duration", async () => {
    const scope = createMeasurementScope(clock([0, 5, 5, 20, 20, 23]));
    const repositories = {
      snapshots: {
        getCurrent: async () => ({ id: "s1" }),
        create: async () => undefined
      },
      rankings: { listForRealm: async () => [] }
    };

    const measured = measuredRepositories(repositories, scope);
    await measured.snapshots.getCurrent();
    await measured.snapshots.create();
    await measured.rankings.listForRealm();

    expect(scope.totals()).toMatchObject({
      dbMaxCallMs: 15,
      dbMaxCallName: "snapshots.create"
    });
  });

  it("names a call that rejects when it is the longest", async () => {
    const scope = createMeasurementScope(clock([0, 9]));
    const measured = measuredRepositories(
      {
        snapshots: {
          getCurrent: async () => {
            throw new Error("connection_lost");
          }
        }
      },
      scope
    );

    await expect(measured.snapshots.getCurrent()).rejects.toThrow(
      "connection_lost"
    );
    expect(scope.totals()).toMatchObject({
      dbMaxCallName: "snapshots.getCurrent"
    });
  });

  it("names the call rather than any argument it was given", async () => {
    const scope = createMeasurementScope(clock([0, 5]));
    const measured = measuredRepositories(
      { snapshots: { getCurrent: async (key: string) => key.length } },
      scope
    );

    await measured.snapshots.getCurrent("eu/silvermoon/tester");

    expect(scope.totals().dbMaxCallName).toBe("snapshots.getCurrent");
  });

  it("emits neither field when no repository call is made", () => {
    const scope = createMeasurementScope(clock([0]));
    measuredRepositories(
      { snapshots: { getCurrent: async () => null } },
      scope
    );

    const totals = scope.totals();
    expect(totals).not.toHaveProperty("dbMaxCallMs");
    expect(totals).not.toHaveProperty("dbMaxCallName");
  });

  it("returns the underlying result unchanged", async () => {
    const scope = createMeasurementScope(clock([0, 1]));
    const measured = measuredRepositories(
      { snapshots: { getCurrent: async () => ({ id: "s1" }) } },
      scope
    );
    await expect(measured.snapshots.getCurrent()).resolves.toEqual({
      id: "s1"
    });
  });

  it("forwards arguments", async () => {
    const getCurrent = vi.fn<(key: string) => Promise<null>>(async () => null);
    const measured = measuredRepositories(
      { snapshots: { getCurrent } },
      createMeasurementScope(clock([0, 1]))
    );
    await measured.snapshots.getCurrent("eu/silvermoon/tester");
    expect(getCurrent).toHaveBeenCalledWith("eu/silvermoon/tester");
  });

  it("records a call that rejects", async () => {
    const scope = createMeasurementScope(clock([0, 9]));
    const measured = measuredRepositories(
      {
        snapshots: {
          getCurrent: async () => {
            throw new Error("connection_lost");
          }
        }
      },
      scope
    );

    await expect(measured.snapshots.getCurrent()).rejects.toThrow(
      "connection_lost"
    );
    expect(scope.totals()).toMatchObject({ dbMs: 9, dbCalls: 1 });
  });

  it("names the roster substep and excludes it from its parent's duration", async () => {
    let now = 0;
    const scope = createMeasurementScope(() => now);
    const measured = measuredRepositories(
      {
        evidence: {
          async hydrateCompletedEvidence(
            _selection: unknown,
            measureReadStep?: <T>(
              label: "evidence.raiderIoRoster",
              work: () => Promise<T>
            ) => Promise<T>
          ) {
            now += 3;
            return measureReadStep
              ? measureReadStep("evidence.raiderIoRoster", async () => {
                  now += 7;
                  return "roster";
                })
              : "unmeasured";
          }
        }
      },
      scope
    );

    await expect(
      measured.evidence.hydrateCompletedEvidence({ id: "opaque" })
    ).resolves.toBe("roster");

    // The parent still counts as a call, but its 3 ms excludes the 7 ms
    // roster step; the total stays the 10 ms the request actually spent, and
    // the roster is named both as the slowest db call and in its own family.
    expect(scope.totals()).toMatchObject({
      dbMs: 10,
      dbCalls: 2,
      dbMaxCallMs: 7,
      dbMaxCallName: "evidence.raiderIoRoster",
      dbRosterMs: 7,
      dbRosterCalls: 1,
      dbRosterMaxCallMs: 7,
      dbRosterMaxCallName: "evidence.raiderIoRoster"
    });
  });

  it("offers the roster observer to each evidence read that hydrates", async () => {
    const scope = createMeasurementScope(clock([0, 0, 0, 0, 0, 0, 0, 0]));
    let rosterSteps = 0;
    let prepareCalls = 0;
    type Measure = <T>(
      label: "evidence.raiderIoRoster",
      work: () => Promise<T>
    ) => Promise<T>;
    const observe = async (measureReadStep?: Measure) => {
      await measureReadStep?.("evidence.raiderIoRoster", async () => {
        rosterSteps += 1;
      });
    };
    const repositories = {
      evidence: {
        reserve: (_input: unknown, measureReadStep?: Measure) =>
          observe(measureReadStep),
        reserveForScheduling: async (
          _input: unknown,
          prepareNewRun?: () => Promise<boolean>,
          measureReadStep?: Measure
        ) => {
          if (prepareNewRun) {
            prepareCalls += 1;
            await prepareNewRun();
          }
          await observe(measureReadStep);
        },
        getCompleted: (_key: unknown, measureReadStep?: Measure) =>
          observe(measureReadStep),
        hydrateCompletedEvidence: (
          _selection: unknown,
          measureReadStep?: Measure
        ) => observe(measureReadStep)
      }
    };

    const measured = measuredRepositories(repositories, scope);

    // Called without an observer: the wrapper supplies one for each method.
    await measured.evidence.reserve({});
    await measured.evidence.reserveForScheduling({}, async () => true);
    await measured.evidence.getCompleted({});
    await measured.evidence.hydrateCompletedEvidence({});

    // The scheduling callback keeps its second position; the observer is
    // supplied in the explicitly declared third position.
    expect(prepareCalls).toBe(1);
    expect(rosterSteps).toBe(4);
    expect(scope.totals()).toMatchObject({
      dbCalls: 8,
      dbMaxCallName: "evidence.raiderIoRoster",
      dbRosterCalls: 4,
      dbRosterMaxCallName: "evidence.raiderIoRoster"
    });
  });

  it("leaves non-function and absent properties alone", () => {
    const measured = measuredRepositories(
      { snapshots: { label: "snapshots" } },
      createMeasurementScope(clock([0]))
    );
    expect(measured.snapshots.label).toBe("snapshots");
    expect(
      (measured.snapshots as Record<string, unknown>).missing
    ).toBeUndefined();
  });
});
