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
