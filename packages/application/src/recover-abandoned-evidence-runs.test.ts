import type { CharacterKey } from "@slashwho/domain";
import type { StagedEvidenceCollection } from "@slashwho/database";
import { describe, expect, it, vi } from "vitest";

import { recoverAbandonedEvidenceRuns } from "./recover-abandoned-evidence-runs";

const startedBefore = new Date("2026-09-18T06:00:00.000Z");
const reservedBefore = new Date("2026-09-18T13:45:00.000Z");
const settleMs = 7 * 24 * 60 * 60 * 1000;

type ActiveRun = {
  runId: string;
  key: CharacterKey;
  queueJobId: string | null;
  startedAt: Date | null;
  createdAt: Date;
};

const key: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "adeline"
};

const liveRun: ActiveRun = {
  runId: "run-live",
  key,
  queueJobId: "job-live",
  startedAt: new Date("2026-09-18T13:55:00.000Z"),
  createdAt: new Date("2026-09-18T13:54:00.000Z")
};

/**
 * A kill in a raid whose content window closed on 2026-08-19, killed long
 * enough ago to have settled -- so it is eligible to be marked terminal, and
 * the trouble sets are the only thing left deciding which domains are.
 */
const settledKill = {
  raidId: "42",
  raidName: "The Dreamrift",
  bossId: "2639",
  bossName: "Chrome King Gallywix",
  journalBossId: null,
  bossOrder: 8,
  killedAt: "2026-06-01T20:00:00.000Z",
  reportUrl: "https://www.warcraftlogs.com/reports/abc",
  fightUrl: "https://www.warcraftlogs.com/reports/abc#fight=12",
  guild: null,
  performance: {
    damage: { state: "unavailable" as const },
    healing: { state: "unavailable" as const },
    bossDamage: { state: "unavailable" as const }
  }
};

/** A scan that finished and was staged on the way to a publication. */
function stage(
  overrides: Partial<StagedEvidenceCollection> = {}
): StagedEvidenceCollection {
  return {
    state: "complete",
    limitationCode: null,
    parseLimitationCode: null,
    retryAfterAt: null,
    kills: [],
    wipes: [],
    tierBests: [],
    completedAt: "2026-09-18T13:26:00.000Z",
    ...overrides
  };
}

function evidenceFor(
  active: readonly ActiveRun[],
  stages: Readonly<Record<string, StagedEvidenceCollection>> = {}
) {
  return {
    listActive: vi.fn(async () => active),
    releaseAbandoned: vi.fn(async (runIds: readonly string[]) => runIds.length),
    stagedCollection: vi.fn(async (runId: string) => stages[runId] ?? null),
    publish: vi.fn(async () => undefined),
    markTerminalTiers: vi.fn(async () => undefined)
  };
}

function queueFor(settled: readonly string[] = []) {
  return {
    settledEvidenceJobIds: vi.fn(async (jobIds: readonly string[]) =>
      jobIds.filter((id) => settled.includes(id))
    )
  };
}

describe("recoverAbandonedEvidenceRuns", () => {
  it("releases a run whose queue job has settled without recording an outcome", async () => {
    // Break caught: a worker killed mid-flight left its run in `running`, and
    // `reserve` counts that as active forever -- so the character never
    // collected again and the resume sweep skipped it as already in hand.
    const evidence = evidenceFor([
      {
        runId: "run-abandoned",
        key,
        queueJobId: "job-dead",
        startedAt: new Date("2026-09-18T13:25:00.000Z"),
        createdAt: new Date("2026-09-18T13:24:00.000Z")
      },
      liveRun
    ]);
    const queue = queueFor(["job-dead"]);

    const result = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(result.released).toBe(1);
    expect(evidence.listActive).toHaveBeenCalledWith(50);
    expect(queue.settledEvidenceJobIds).toHaveBeenCalledWith([
      "job-dead",
      "job-live"
    ]);
    expect(evidence.releaseAbandoned).toHaveBeenCalledWith(["run-abandoned"]);
  });

  it("leaves a run whose queue job is still runnable alone", async () => {
    const evidence = evidenceFor([liveRun]);
    const queue = queueFor();

    const result = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(result.released).toBe(0);
    expect(evidence.releaseAbandoned).not.toHaveBeenCalled();
  });

  it("never asks the queue about a run that has not been enqueued yet", async () => {
    // `reserve` inserts the run row before `enqueue` returns an id, so a run
    // with no job id can be milliseconds old. Asking the queue about it would
    // find nothing and kill a run a reader is still starting.
    const evidence = evidenceFor([
      {
        runId: "run-reserving",
        key,
        queueJobId: null,
        startedAt: null,
        createdAt: new Date("2026-09-18T13:59:59.000Z")
      }
    ]);
    const queue = queueFor();

    const result = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(result.released).toBe(0);
    expect(queue.settledEvidenceJobIds).not.toHaveBeenCalled();
    expect(evidence.releaseAbandoned).not.toHaveBeenCalled();
  });

  it("releases a never-claimed run with no job id within minutes", async () => {
    // Nothing ever touched this run: `reserve` created the row and the process
    // died before `enqueue` returned. It cannot be in a deferral chain, so it
    // has no need of the long backstop -- and a character born orphaned would
    // otherwise be invisible for most of a working day.
    const evidence = evidenceFor([
      {
        runId: "run-stranded",
        key,
        queueJobId: null,
        startedAt: null,
        createdAt: new Date("2026-09-18T13:30:00.000Z")
      }
    ]);
    const queue = queueFor();

    const result = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(result.released).toBe(1);
    expect(evidence.releaseAbandoned).toHaveBeenCalledWith(["run-stranded"]);
  });

  it("holds a claimed run with no job id to the long backstop", async () => {
    // `markEnqueued` requires status `queued`, so a worker that claims the job
    // before the enqueuing process records its id leaves a genuinely running
    // run with no job id for its whole life. The short cutoff must not reach
    // it: the worker is collecting right now, and releasing it would throw
    // that scan away at `publish` and pay for it again.
    const evidence = evidenceFor([
      {
        runId: "run-claimed-unrecorded",
        key,
        queueJobId: null,
        startedAt: new Date("2026-09-18T13:20:00.000Z"),
        createdAt: new Date("2026-09-18T13:19:00.000Z")
      }
    ]);
    const queue = queueFor();

    const result = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(result.released).toBe(0);
    expect(evidence.releaseAbandoned).not.toHaveBeenCalled();
  });

  it("holds a freshly reserved run that has not been enqueued yet", async () => {
    // The race the short cutoff must survive: `reserve` inserts the row and
    // `markEnqueued` follows milliseconds later, so a young null-job-id run is
    // one still being started, not one that was orphaned.
    const evidence = evidenceFor([
      {
        runId: "run-reserving-now",
        key,
        queueJobId: null,
        startedAt: null,
        createdAt: new Date("2026-09-18T13:59:59.000Z")
      }
    ]);
    const queue = queueFor();

    const result = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(result.released).toBe(0);
    expect(evidence.releaseAbandoned).not.toHaveBeenCalled();
  });

  it("releases a claimed run that outlived even the long backstop", async () => {
    // The time arm is a backstop, not a second opinion: a job pg-boss has
    // forgotten to expire must not hold a character indefinitely.
    const evidence = evidenceFor([
      {
        runId: "run-old",
        key,
        queueJobId: "job-old",
        startedAt: new Date("2026-09-18T01:00:00.000Z"),
        createdAt: new Date("2026-09-18T01:00:00.000Z")
      }
    ]);
    const queue = queueFor();

    const result = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(result.released).toBe(1);
    expect(evidence.releaseAbandoned).toHaveBeenCalledWith(["run-old"]);
  });

  it("reports nothing released when a publisher wins the race", async () => {
    // `releaseAbandoned` is guarded on the active statuses, so a run that
    // published between the read and the write is not counted as recovered.
    const evidence = evidenceFor([
      {
        runId: "run-publishing",
        key,
        queueJobId: "job-dead",
        startedAt: new Date("2026-09-18T13:25:00.000Z"),
        createdAt: new Date("2026-09-18T13:24:00.000Z")
      }
    ]);
    evidence.releaseAbandoned.mockResolvedValue(0);
    const queue = queueFor(["job-dead"]);

    const result = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(result.released).toBe(0);
  });

  it("does not touch the database when nothing is active", async () => {
    const evidence = evidenceFor([]);
    const queue = queueFor();

    const result = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(result.released).toBe(0);
    expect(queue.settledEvidenceJobIds).not.toHaveBeenCalled();
    expect(evidence.releaseAbandoned).not.toHaveBeenCalled();
  });

  it("publishes an abandoned run's staged collection instead of releasing it", async () => {
    // The scan is the expensive part of a run -- 68-86% of its cost by the
    // #308 counters -- and the stage is exactly that scan's output. Releasing
    // the run throws it away and makes the replacement pay for it again.
    const evidence = evidenceFor(
      [
        {
          runId: "run-staged",
          key,
          queueJobId: "job-dead",
          startedAt: new Date("2026-09-18T13:25:00.000Z"),
          createdAt: new Date("2026-09-18T13:24:00.000Z")
        }
      ],
      { "run-staged": stage() }
    );
    const queue = queueFor(["job-dead"]);

    const result = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(result).toEqual({ released: 0, republished: 1 });
    expect(evidence.publish).toHaveBeenCalledWith("run-staged", {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      // A stage written before #349 carries no list, and the code it was
      // judged by stands in for itself -- here, nothing went wrong at all.
      parseLimitationCodesSeen: [],
      kills: [],
      wipes: [],
      tierBests: [],
      // Old stages never carried Blizzard results; recovery republishes that
      // fact as an empty set rather than inventing provider evidence.
      cuttingEdges: [],
      // Likewise: a stage from before this field recorded no attempts, and
      // reading its silence as "none" only costs a re-request.
      parsedFightUrls: [],
      completedAt: new Date("2026-09-18T13:26:00.000Z")
    });
    expect(evidence.releaseAbandoned).not.toHaveBeenCalled();
  });

  it("carries a staged retry deadline through, so the resume pass can take it", async () => {
    // Recovery runs before `resumeWaitingEvidence` on the same tick, so a
    // partial stage republished here is resumed immediately rather than
    // waiting for somebody to load the dossier.
    const evidence = evidenceFor(
      [
        {
          runId: "run-partial",
          key,
          queueJobId: "job-dead",
          startedAt: new Date("2026-09-18T13:25:00.000Z"),
          createdAt: new Date("2026-09-18T13:24:00.000Z")
        }
      ],
      {
        "run-partial": stage({
          state: "partial",
          parseLimitationCode: "parse_request_cap",
          retryAfterAt: "2026-09-18T15:00:00.000Z"
        })
      }
    );
    const queue = queueFor(["job-dead"]);

    await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(evidence.publish).toHaveBeenCalledWith(
      "run-partial",
      expect.objectContaining({
        state: "partial",
        retryAfterAt: new Date("2026-09-18T15:00:00.000Z")
      })
    );
  });

  it("releases an abandoned run whose publication throws", async () => {
    // Two cases, one handler. A malformed stage must not leave the run active
    // for ever, and a run that published for real between the read and the
    // write throws `character_evidence_run_not_active` -- for which
    // `releaseAbandoned`'s own status guard makes this fallback a no-op.
    const evidence = evidenceFor(
      [
        {
          runId: "run-bad-stage",
          key,
          queueJobId: "job-dead",
          startedAt: new Date("2026-09-18T13:25:00.000Z"),
          createdAt: new Date("2026-09-18T13:24:00.000Z")
        }
      ],
      { "run-bad-stage": stage() }
    );
    evidence.publish.mockRejectedValue(
      new RangeError("character_evidence_publication_invalid")
    );
    const queue = queueFor(["job-dead"]);

    const result = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(result).toEqual({ released: 1, republished: 0 });
    expect(evidence.releaseAbandoned).toHaveBeenCalledWith(["run-bad-stage"]);
  });

  it("marks the terminal tiers the original run would have", async () => {
    // The stage carries the trouble sets so this is computable at all. Without
    // them a republished run stores evidence but settles nothing, and the
    // character re-pays for zones and scan pages it had already earned the
    // right to stop re-querying.
    const evidence = evidenceFor(
      [
        {
          runId: "run-settling",
          key,
          queueJobId: "job-dead",
          startedAt: new Date("2026-09-18T13:25:00.000Z"),
          createdAt: new Date("2026-09-18T13:24:00.000Z")
        }
      ],
      {
        "run-settling": stage({
          kills: [settledKill],
          troubledRaidIds: { parses: [settledKill.raidId], tierBests: [] }
        })
      }
    );
    const queue = queueFor(["job-dead"]);

    await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    // Kills and tier bests settle; parses stay re-queryable because the run
    // attributed a limitation to that raid in that domain.
    expect(evidence.markTerminalTiers).toHaveBeenCalledWith(
      key,
      [
        { raidId: settledKill.raidId, domain: "kills" },
        { raidId: settledKill.raidId, domain: "tier_bests" }
      ],
      new Date("2026-09-18T13:26:00.000Z")
    );
  });

  it("marks nothing for a stage written before trouble sets were carried", async () => {
    // Absent is not empty. A stage from before this shipped cannot say which
    // raids it had trouble with, and assuming none would over-mark and freeze
    // the parse gaps the trouble sets exist to keep open.
    const evidence = evidenceFor(
      [
        {
          runId: "run-old-stage",
          key,
          queueJobId: "job-dead",
          startedAt: new Date("2026-09-18T13:25:00.000Z"),
          createdAt: new Date("2026-09-18T13:24:00.000Z")
        }
      ],
      { "run-old-stage": stage({ kills: [settledKill] }) }
    );
    const queue = queueFor(["job-dead"]);

    const result = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(result.republished).toBe(1);
    expect(evidence.markTerminalTiers).not.toHaveBeenCalled();
  });

  it("leaves a republished run published when marking fails", async () => {
    // The evidence is stored and the run is no longer active, so releasing it
    // now would be wrong. A lost mark only costs a re-query.
    const evidence = evidenceFor(
      [
        {
          runId: "run-mark-fails",
          key,
          queueJobId: "job-dead",
          startedAt: new Date("2026-09-18T13:25:00.000Z"),
          createdAt: new Date("2026-09-18T13:24:00.000Z")
        }
      ],
      {
        "run-mark-fails": stage({
          kills: [settledKill],
          troubledRaidIds: { parses: [], tierBests: [] }
        })
      }
    );
    evidence.markTerminalTiers.mockRejectedValue(new Error("mark_failed"));
    const queue = queueFor(["job-dead"]);

    const result = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(result).toEqual({ released: 0, republished: 1 });
    expect(evidence.releaseAbandoned).not.toHaveBeenCalled();
  });

  it("publishes the staged runs and releases the rest in one sweep", async () => {
    const evidence = evidenceFor(
      [
        {
          runId: "run-with-stage",
          key,
          queueJobId: "job-dead-a",
          startedAt: new Date("2026-09-18T13:25:00.000Z"),
          createdAt: new Date("2026-09-18T13:24:00.000Z")
        },
        {
          runId: "run-without-stage",
          key,
          queueJobId: "job-dead-b",
          startedAt: new Date("2026-09-18T13:25:00.000Z"),
          createdAt: new Date("2026-09-18T13:24:00.000Z")
        }
      ],
      { "run-with-stage": stage() }
    );
    const queue = queueFor(["job-dead-a", "job-dead-b"]);

    const result = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(result).toEqual({ released: 1, republished: 1 });
    // One batched write for everything with nothing worth keeping.
    expect(evidence.releaseAbandoned).toHaveBeenCalledTimes(1);
    expect(evidence.releaseAbandoned).toHaveBeenCalledWith([
      "run-without-stage"
    ]);
  });

  it("never asks for the stage of a run it is leaving alone", async () => {
    const evidence = evidenceFor([liveRun]);
    const queue = queueFor();

    await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      settleMs,
      limit: 50
    });

    expect(evidence.stagedCollection).not.toHaveBeenCalled();
  });
});
