import { describe, expect, it, vi } from "vitest";

import { recoverAbandonedEvidenceRuns } from "./recover-abandoned-evidence-runs";

const startedBefore = new Date("2026-09-18T06:00:00.000Z");
const reservedBefore = new Date("2026-09-18T13:45:00.000Z");

type ActiveRun = {
  runId: string;
  queueJobId: string | null;
  startedAt: Date | null;
  createdAt: Date;
};

const liveRun: ActiveRun = {
  runId: "run-live",
  queueJobId: "job-live",
  startedAt: new Date("2026-09-18T13:55:00.000Z"),
  createdAt: new Date("2026-09-18T13:54:00.000Z")
};

function evidenceFor(active: readonly ActiveRun[]) {
  return {
    listActive: vi.fn(async () => active),
    releaseAbandoned: vi.fn(async (runIds: readonly string[]) => runIds.length)
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
        queueJobId: "job-dead",
        startedAt: new Date("2026-09-18T13:25:00.000Z"),
        createdAt: new Date("2026-09-18T13:24:00.000Z")
      },
      liveRun
    ]);
    const queue = queueFor(["job-dead"]);

    const released = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      limit: 50
    });

    expect(released).toBe(1);
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

    const released = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      limit: 50
    });

    expect(released).toBe(0);
    expect(evidence.releaseAbandoned).not.toHaveBeenCalled();
  });

  it("never asks the queue about a run that has not been enqueued yet", async () => {
    // `reserve` inserts the run row before `enqueue` returns an id, so a run
    // with no job id can be milliseconds old. Asking the queue about it would
    // find nothing and kill a run a reader is still starting.
    const evidence = evidenceFor([
      {
        runId: "run-reserving",
        queueJobId: null,
        startedAt: null,
        createdAt: new Date("2026-09-18T13:59:59.000Z")
      }
    ]);
    const queue = queueFor();

    const released = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      limit: 50
    });

    expect(released).toBe(0);
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
        queueJobId: null,
        startedAt: null,
        createdAt: new Date("2026-09-18T13:30:00.000Z")
      }
    ]);
    const queue = queueFor();

    const released = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      limit: 50
    });

    expect(released).toBe(1);
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
        queueJobId: null,
        startedAt: new Date("2026-09-18T13:20:00.000Z"),
        createdAt: new Date("2026-09-18T13:19:00.000Z")
      }
    ]);
    const queue = queueFor();

    const released = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      limit: 50
    });

    expect(released).toBe(0);
    expect(evidence.releaseAbandoned).not.toHaveBeenCalled();
  });

  it("holds a freshly reserved run that has not been enqueued yet", async () => {
    // The race the short cutoff must survive: `reserve` inserts the row and
    // `markEnqueued` follows milliseconds later, so a young null-job-id run is
    // one still being started, not one that was orphaned.
    const evidence = evidenceFor([
      {
        runId: "run-reserving-now",
        queueJobId: null,
        startedAt: null,
        createdAt: new Date("2026-09-18T13:59:59.000Z")
      }
    ]);
    const queue = queueFor();

    const released = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      limit: 50
    });

    expect(released).toBe(0);
    expect(evidence.releaseAbandoned).not.toHaveBeenCalled();
  });

  it("releases a claimed run that outlived even the long backstop", async () => {
    // The time arm is a backstop, not a second opinion: a job pg-boss has
    // forgotten to expire must not hold a character indefinitely.
    const evidence = evidenceFor([
      {
        runId: "run-old",
        queueJobId: "job-old",
        startedAt: new Date("2026-09-18T01:00:00.000Z"),
        createdAt: new Date("2026-09-18T01:00:00.000Z")
      }
    ]);
    const queue = queueFor();

    const released = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      limit: 50
    });

    expect(released).toBe(1);
    expect(evidence.releaseAbandoned).toHaveBeenCalledWith(["run-old"]);
  });

  it("reports nothing released when a publisher wins the race", async () => {
    // `releaseAbandoned` is guarded on the active statuses, so a run that
    // published between the read and the write is not counted as recovered.
    const evidence = {
      listActive: vi.fn(async () => [
        {
          runId: "run-publishing",
          queueJobId: "job-dead",
          startedAt: new Date("2026-09-18T13:25:00.000Z"),
          createdAt: new Date("2026-09-18T13:24:00.000Z")
        }
      ]),
      releaseAbandoned: vi.fn(async () => 0)
    };
    const queue = queueFor(["job-dead"]);

    const released = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      limit: 50
    });

    expect(released).toBe(0);
  });

  it("does not touch the database when nothing is active", async () => {
    const evidence = evidenceFor([]);
    const queue = queueFor();

    const released = await recoverAbandonedEvidenceRuns(evidence, queue, {
      startedBefore,
      reservedBefore,
      limit: 50
    });

    expect(released).toBe(0);
    expect(queue.settledEvidenceJobIds).not.toHaveBeenCalled();
    expect(evidence.releaseAbandoned).not.toHaveBeenCalled();
  });
});
