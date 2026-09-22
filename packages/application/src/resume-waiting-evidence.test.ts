import type { CharacterKey } from "@slashwho/domain";
import { describe, expect, it, vi } from "vitest";

import { resumeWaitingEvidence } from "./resume-waiting-evidence";

const ryii = { region: "eu", realm: "silvermoon", name: "ryii" } as const;
const riln = { region: "eu", realm: "silvermoon", name: "riln" } as const;

const at = new Date("2026-09-18T13:08:00.000Z");
const freshnessCutoff = new Date("2026-09-17T13:08:00.000Z");

function run(id: string) {
  return { id };
}

type Reservation = { kind: string; run: { id: string } };

function evidenceFor(
  due: readonly CharacterKey[],
  reserve: () => Promise<Reservation> = async () => ({
    kind: "reserved",
    run: run("r-1")
  })
) {
  return {
    listResumable: vi.fn(async () => due),
    reserve: vi.fn(reserve),
    markEnqueued: vi.fn(async () => undefined)
  };
}

function queueFor() {
  return { enqueueCharacterEvidence: vi.fn(async () => "job-1") };
}

describe("resumeWaitingEvidence", () => {
  it("reserves and enqueues every character whose deadline has passed", async () => {
    // Break caught: a waiting run was eligible to resume and nothing drove it,
    // so a dossier nobody read never finished collecting.
    const evidence = evidenceFor([ryii, riln]);
    const queue = queueFor();

    const resumed = await resumeWaitingEvidence(evidence, queue, {
      freshnessCutoff,
      limit: 25,
      at
    });

    expect(resumed).toBe(2);
    expect(evidence.listResumable).toHaveBeenCalledWith(25, at);
    expect(evidence.reserve).toHaveBeenCalledWith({
      key: ryii,
      freshnessCutoff,
      at,
      phasePlan: [
        "warcraft_logs_history",
        "warcraft_logs_tier_bests",
        "warcraft_logs_fight_parses",
        "warcraft_logs_ranking_identities",
        "raiderio_rankings",
        "blizzard_achievements",
        "publication"
      ]
    });
    expect(queue.enqueueCharacterEvidence).toHaveBeenCalledTimes(2);
    expect(evidence.markEnqueued).toHaveBeenCalledWith("r-1", "job-1");
  });

  it("skips a character a reader already started collecting", async () => {
    // The sweep and a dossier read race by design. `reserve` settles it, and
    // whichever lost simply does nothing rather than enqueueing a second run.
    const evidence = evidenceFor([ryii], async () => ({
      kind: "active",
      run: run("r-other")
    }));
    const queue = queueFor();

    const resumed = await resumeWaitingEvidence(evidence, queue, {
      freshnessCutoff,
      limit: 25,
      at
    });

    expect(resumed).toBe(0);
    expect(queue.enqueueCharacterEvidence).not.toHaveBeenCalled();
    expect(evidence.markEnqueued).not.toHaveBeenCalled();
  });

  it("carries no credentials, so a sweep spends the worker's own allowance", async () => {
    // A visitor's encrypted WCL credentials belong to the read that supplied
    // them. A background sweep has no visitor, and reserving with theirs would
    // spend a stranger's allowance on nobody's dossier.
    const evidence = evidenceFor([ryii]);

    await resumeWaitingEvidence(evidence, queueFor(), {
      freshnessCutoff,
      limit: 25,
      at
    });

    expect(evidence.reserve).toHaveBeenCalledWith({
      key: ryii,
      freshnessCutoff,
      at,
      phasePlan: [
        "warcraft_logs_history",
        "warcraft_logs_tier_bests",
        "warcraft_logs_fight_parses",
        "warcraft_logs_ranking_identities",
        "raiderio_rankings",
        "blizzard_achievements",
        "publication"
      ]
    });
  });

  it("keeps sweeping after one character fails to enqueue", async () => {
    // One unenqueueable character must not strand the rest of the batch: the
    // sweep is the only thing driving any of them.
    const evidence = evidenceFor([ryii, riln]);
    const queue = queueFor();
    queue.enqueueCharacterEvidence.mockRejectedValueOnce(new Error("boom"));

    const resumed = await resumeWaitingEvidence(evidence, queue, {
      freshnessCutoff,
      limit: 25,
      at
    });

    expect(resumed).toBe(1);
    expect(queue.enqueueCharacterEvidence).toHaveBeenCalledTimes(2);
  });

  it("does nothing at all when nothing is due", async () => {
    const evidence = evidenceFor([]);
    const queue = queueFor();

    expect(
      await resumeWaitingEvidence(evidence, queue, {
        freshnessCutoff,
        limit: 25,
        at
      })
    ).toBe(0);
    expect(evidence.reserve).not.toHaveBeenCalled();
    expect(queue.enqueueCharacterEvidence).not.toHaveBeenCalled();
  });
});
