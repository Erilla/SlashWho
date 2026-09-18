import { describe, expect, it, vi } from "vitest";

import { createMeasurementScope } from "./measurement";
import { refreshCharacter } from "./refresh-character";

const key = { region: "eu" as const, realm: "silvermoon", name: "ryii" };
const at = new Date("2026-09-16T12:00:00.000Z");
const cooldownMs = 15 * 60 * 1000;

function harness(lastCompletedAt: Date | null, rebuild = false) {
  const reserve = vi.fn().mockResolvedValue({
    kind: "reserved",
    run: { id: "run-1", key, status: "queued" }
  });
  const clearTerminalTiers = vi.fn().mockResolvedValue(3);
  const getCompleted = vi
    .fn()
    .mockResolvedValue(
      lastCompletedAt === null
        ? null
        : { run: { id: "run-0", key, completedAt: lastCompletedAt } }
    );
  const markEnqueued = vi.fn().mockResolvedValue(undefined);
  const enqueueCharacterEvidence = vi.fn().mockResolvedValue("job-1");
  return {
    reserve,
    getCompleted,
    markEnqueued,
    enqueueCharacterEvidence,
    clearTerminalTiers,
    run: () =>
      refreshCharacter({
        key,
        at,
        cooldownMs,
        ...(rebuild ? { rebuild: true } : {}),
        repositories: {
          evidence: {
            reserve,
            getCompleted,
            markEnqueued,
            clearTerminalTiers
          }
        } as never,
        queue: { enqueueCharacterEvidence } as never
      })
  };
}

describe("refreshCharacter", () => {
  it("collects everything when the character is outside its cooldown", async () => {
    const h = harness(new Date("2026-09-16T11:00:00.000Z"));

    await expect(h.run()).resolves.toMatchObject({ mode: "full" });

    // A cutoff of `at` leaves nothing fresh, which is what forces a new run
    // without touching the shared freshness window.
    expect(h.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ key, freshnessCutoff: at })
    );
    expect(h.enqueueCharacterEvidence).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ mode: "full" })
    );
  });

  it("only looks for new kills when pressed inside the cooldown", async () => {
    const h = harness(new Date("2026-09-16T11:55:00.000Z"));

    await expect(h.run()).resolves.toMatchObject({ mode: "light" });

    expect(h.enqueueCharacterEvidence).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ mode: "light" })
    );
  });

  it("reports the collection it refreshed from", async () => {
    const lastCompletedAt = new Date("2026-09-16T11:00:00.000Z");
    const h = harness(lastCompletedAt);

    await expect(h.run()).resolves.toMatchObject({
      lastCollectedAt: lastCompletedAt
    });
  });

  it("measures the database work it does", async () => {
    // Break caught: refresh is the one path a reader can trigger collection
    // from, so an unmeasured one leaves the load it causes invisible in the
    // logs while every other endpoint reports its breakdown.
    const h = harness(new Date("2026-09-16T11:00:00.000Z"));
    let ticks = 0;
    const scope = createMeasurementScope(() => (ticks += 5));

    await refreshCharacter({
      key,
      at,
      cooldownMs,
      scope,
      repositories: {
        evidence: {
          reserve: h.reserve,
          getCompleted: h.getCompleted,
          markEnqueued: h.markEnqueued
        }
      } as never,
      queue: { enqueueCharacterEvidence: h.enqueueCharacterEvidence } as never
    });

    expect(scope.totals()).toMatchObject({ dbCalls: 3 });
  });

  it("joins a collection already running rather than queuing a second", async () => {
    // Break caught: a refresh pressed while collection is in flight must not
    // stack another run against a rate-limited upstream.
    const h = harness(new Date("2026-09-16T11:00:00.000Z"));
    h.reserve.mockResolvedValue({
      kind: "active",
      run: { id: "run-active", key, status: "running" }
    });

    await expect(h.run()).resolves.toMatchObject({ mode: "full" });

    expect(h.enqueueCharacterEvidence).not.toHaveBeenCalled();
  });

  it("clears every terminal mark before reserving a rebuild", async () => {
    const h = harness(new Date("2026-09-16T11:00:00.000Z"), true);

    await expect(h.run()).resolves.toMatchObject({
      mode: "rebuild",
      clearedTiers: 3
    });

    expect(h.clearTerminalTiers).toHaveBeenCalledWith(key);
  });

  it("does not clear terminal marks on an ordinary refresh", async () => {
    // The reader-facing control must never re-collect a character's history.
    const h = harness(new Date("2026-09-16T11:00:00.000Z"));

    await h.run();

    expect(h.clearTerminalTiers).not.toHaveBeenCalled();
  });

  it("does not clear terminal marks inside the cooldown either", async () => {
    const h = harness(new Date("2026-09-16T11:55:00.000Z"));

    await expect(h.run()).resolves.toMatchObject({ mode: "light" });

    expect(h.clearTerminalTiers).not.toHaveBeenCalled();
  });

  it("queues a rebuild as one ordinary run, not a whole history at once", async () => {
    // The flag is the whole mechanism. One character spans 353 reports and no
    // single run can afford that, so the backlog drains across as many runs as
    // the budget allows.
    const h = harness(new Date("2026-09-16T11:00:00.000Z"), true);

    await h.run();

    expect(h.enqueueCharacterEvidence).toHaveBeenCalledTimes(1);
    expect(h.enqueueCharacterEvidence).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ mode: "full" })
    );
  });
});
