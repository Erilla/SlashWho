import { describe, expect, it, vi } from "vitest";

import {
  createEvidencePhaseLedger,
  evidencePhasePlans
} from "./evidence-phase-ledger";

describe("evidence phase ledger", () => {
  it("skips unrequested earlier phases when a later request starts", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const ledger = createEvidencePhaseLedger({
      plan: evidencePhasePlans.warcraftLogs({
        scan: true,
        tierBests: true,
        fightParses: true
      }),
      now: () => new Date("2026-09-22T10:00:00.000Z"),
      persist
    });
    await ledger.seed();
    await ledger.transition("warcraft_logs_identity_resolution", "skipped");
    await ledger.transition("warcraft_logs_history", "active");
    await ledger.transition("warcraft_logs_history", "completed");
    await ledger.transition("warcraft_logs_fight_parses", "active");
    await ledger.transition("warcraft_logs_fight_parses", "completed");

    expect(persist).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "warcraft_logs_tier_bests",
        state: "skipped"
      }),
      expect.objectContaining({
        id: "warcraft_logs_fight_parses",
        state: "active"
      })
    ]);
  });
  it("seeds only an applicable plan and coalesces repeated active notices", async () => {
    // Break caught: an impossible provider phase could remain pending forever,
    // or a history scan could write once per page instead of once per state.
    const persist = vi.fn().mockResolvedValue(undefined);
    const ledger = createEvidencePhaseLedger({
      plan: evidencePhasePlans.warcraftLogs({
        scan: true,
        tierBests: false,
        fightParses: true
      }),
      now: () => new Date("2026-09-22T10:00:00.000Z"),
      persist
    });

    await ledger.seed();
    await ledger.transition("warcraft_logs_identity_resolution", "active");
    await ledger.transition("warcraft_logs_identity_resolution", "completed");
    await ledger.transition("warcraft_logs_history", "active");
    await ledger.transition("warcraft_logs_history", "active");

    expect(persist).toHaveBeenCalledTimes(4);
    expect(persist).toHaveBeenNthCalledWith(1, [
      { id: "warcraft_logs_identity_resolution", state: "pending" },
      { id: "warcraft_logs_history", state: "pending" },
      { id: "warcraft_logs_fight_parses", state: "pending" },
      { id: "warcraft_logs_ranking_identities", state: "pending" },
      { id: "publication", state: "pending" }
    ]);
    expect(persist).toHaveBeenNthCalledWith(4, [
      {
        id: "warcraft_logs_history",
        state: "active",
        startedAt: new Date("2026-09-22T10:00:00.000Z")
      }
    ]);
  });

  it("rejects out-of-order and arbitrary transitions", async () => {
    // Break caught: callers could fabricate a completed publication or write
    // a row outside the approved phase plan.
    const ledger = createEvidencePhaseLedger({
      plan: evidencePhasePlans.warcraftLogs({
        scan: true,
        tierBests: false,
        fightParses: false
      }),
      now: () => new Date("2026-09-22T10:00:00.000Z"),
      persist: async () => undefined
    });
    await ledger.seed();

    await expect(ledger.transition("publication", "completed")).rejects.toThrow(
      "evidence_phase_transition_invalid"
    );
    await expect(
      ledger.transition("blizzard_achievements", "active")
    ).rejects.toThrow("evidence_phase_unknown");
  });

  it("retains active work on an unknown stop and marks known cancellation", async () => {
    // Break caught: interruption could be presented as either finished or
    // resumable when neither fact is known.
    const persist = vi.fn().mockResolvedValue(undefined);
    const ledger = createEvidencePhaseLedger({
      plan: evidencePhasePlans.warcraftLogs({
        scan: true,
        tierBests: false,
        fightParses: false
      }),
      now: () => new Date("2026-09-22T10:00:00.000Z"),
      persist
    });
    await ledger.seed();
    await ledger.transition("warcraft_logs_identity_resolution", "skipped");
    await ledger.transition("warcraft_logs_history", "active");
    await ledger.unknownStop();
    await ledger.cancelActive();

    expect(persist).toHaveBeenLastCalledWith([
      {
        id: "warcraft_logs_history",
        state: "cancelled",
        startedAt: new Date("2026-09-22T10:00:00.000Z"),
        completedAt: new Date("2026-09-22T10:00:00.000Z")
      }
    ]);
  });
});
