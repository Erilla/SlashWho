import { supportedRaidCatalogue } from "@slashwho/domain";
import { describe, expect, it, vi } from "vitest";

import { fullEvidencePhasePlan } from "./evidence-phase-ledger";
import { searchCharacterTier } from "./search-character-tier";
import { TIER_SEARCH_SPACING_MS } from "./tier-search";

const key = { region: "eu" as const, realm: "silvermoon", name: "ryun" };
const at = new Date("2026-09-23T12:00:00.000Z");
const eternalPalace = supportedRaidCatalogue().find(
  (raid) => raid.raidName === "The Eternal Palace"
)!.raidId;

function harness(reservation: unknown) {
  const reserveTierSearch = vi.fn().mockResolvedValue(reservation);
  const reserve = vi.fn();
  const markEnqueued = vi.fn().mockResolvedValue(undefined);
  const enqueueCharacterEvidence = vi.fn().mockResolvedValue("job-1");
  const search = (raidId = eternalPalace) =>
    searchCharacterTier({
      key,
      raidId,
      at,
      repositories: {
        evidence: { reserveTierSearch, reserve, markEnqueued } as never
      },
      queue: { enqueueCharacterEvidence }
    });
  return {
    reserveTierSearch,
    reserve,
    markEnqueued,
    enqueueCharacterEvidence,
    search
  };
}

const tierRun = (overrides: Record<string, unknown> = {}) => ({
  id: "run-1",
  key,
  status: "queued",
  mode: "tier_search",
  tierSearchRaidId: eternalPalace,
  createdAt: at,
  ...overrides
});

describe("searching one character's tier", () => {
  it("reserves a tier search, rate limited per tier, and queues it", async () => {
    const test = harness({ kind: "reserved", run: tierRun() });

    await expect(test.search()).resolves.toEqual({ kind: "queued" });

    expect(test.reserveTierSearch).toHaveBeenCalledWith({
      key,
      raidId: eternalPalace,
      at,
      searchedSince: new Date(at.getTime() - TIER_SEARCH_SPACING_MS),
      phasePlan: fullEvidencePhasePlan()
    });
    // The mode is the run's, never the payload's: nothing that re-enqueues
    // without a payload can turn a search into a default.
    expect(test.enqueueCharacterEvidence).toHaveBeenCalledWith("run-1", {
      enqueuedAt: at.toISOString(),
      mode: "full"
    });
    expect(test.markEnqueued).toHaveBeenCalledWith("run-1", "job-1");
    // Never the ordinary reservation: a search is not a refresh.
    expect(test.reserve).not.toHaveBeenCalled();
  });

  it("refuses a raid it has no window for, before reserving anything", async () => {
    const test = harness({ kind: "reserved", run: tierRun() });

    await expect(test.search("not-a-raid")).resolves.toEqual({
      kind: "unknown_tier"
    });
    expect(test.reserveTierSearch).not.toHaveBeenCalled();
  });

  it("says whether the run in flight is this tier's search", async () => {
    const running = harness({
      kind: "active",
      run: tierRun({ status: "running" })
    });
    await expect(running.search()).resolves.toEqual({
      kind: "busy",
      searchingThisTier: true,
      status: "running"
    });

    const ordinary = harness({
      kind: "active",
      run: tierRun({ mode: "full", tierSearchRaidId: null })
    });
    await expect(ordinary.search()).resolves.toEqual({
      kind: "busy",
      searchingThisTier: false,
      status: "queued"
    });
    expect(ordinary.enqueueCharacterEvidence).not.toHaveBeenCalled();
  });

  it("names when a recently searched tier may be searched again", async () => {
    const searchedAt = new Date("2026-09-23T06:00:00.000Z");
    const test = harness({
      kind: "recent",
      run: tierRun({ createdAt: searchedAt, status: "complete" })
    });

    await expect(test.search()).resolves.toEqual({
      kind: "recent",
      status: "complete",
      searchedAt,
      searchableAgainAt: new Date(searchedAt.getTime() + TIER_SEARCH_SPACING_MS)
    });
    expect(test.enqueueCharacterEvidence).not.toHaveBeenCalled();
  });

  it("asks for an ordinary collection first when there is nothing to add to", async () => {
    const test = harness({ kind: "no_evidence" });

    await expect(test.search()).resolves.toEqual({ kind: "no_evidence" });
    expect(test.enqueueCharacterEvidence).not.toHaveBeenCalled();
  });
});
