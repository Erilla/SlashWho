import { describe, expect, it, vi } from "vitest";

import { startApplicantCollection } from "./start-applicant-collection";

const key = { region: "eu" as const, realm: "silvermoon", name: "rinn" };

describe("startApplicantCollection", () => {
  it("admits discovery without placing the upstream root in the job", async () => {
    // Break caught: applicant submissions persisted private upstream identity.
    const enqueue = vi.fn().mockResolvedValue("discovery-job");
    const getCharacter = vi.fn().mockResolvedValue({
      key,
      displayName: "Rinn",
      className: "Mage",
      level: 80,
      guild: null,
      declaredMain: null,
      ownerId: "private-owner",
      profileGuess: "private-discord-profile"
    });
    await expect(
      startApplicantCollection({
        key,
        observedAt: new Date("2026-09-27T12:00:00.000Z"),
        discoveryFreshnessHours: 24,
        evidenceFreshnessHours: 24,
        repositories: {
          suppressions: { isActive: vi.fn().mockResolvedValue(false) },
          searchReservations: {
            reserve: vi.fn().mockResolvedValue({
              kind: "reserved",
              run: { id: "discovery-run" }
            }),
            markEnqueued: vi.fn(),
            cancel: vi.fn()
          },
          evidence: { reserve: vi.fn().mockResolvedValue({ kind: "fresh" }) }
        } as never,
        queue: {
          enqueue,
          enqueueCharacterEvidence: vi.fn(),
          promoteCharacterEvidence: vi.fn()
        },
        raiderio: { getCharacter }
      })
    ).resolves.toBe("started");
    expect(getCharacter).toHaveBeenCalledExactlyOnceWith(key);
    expect(enqueue.mock.calls).toEqual([
      [
        {
          runId: "discovery-run",
          key,
          enqueuedAt: expect.any(String)
        }
      ]
    ]);
  });

  it("reserves evidence as an applicant sheet submission", async () => {
    // Break caught: nothing recorded why a run was queued, so a queue backed
    // up by applicant submissions could not be told from one backed up by
    // readers (#708).
    const enqueueCharacterEvidence = vi.fn().mockResolvedValue("job-1");
    const reserve = vi.fn().mockResolvedValue({
      kind: "reserved",
      run: { id: "evidence-run" }
    });

    await startApplicantCollection({
      key,
      observedAt: new Date("2026-09-27T12:00:00.000Z"),
      discoveryFreshnessHours: 24,
      evidenceFreshnessHours: 24,
      repositories: {
        suppressions: { isActive: vi.fn().mockResolvedValue(false) },
        searchReservations: {
          reserve: vi.fn().mockResolvedValue({ kind: "fresh" })
        },
        evidence: { reserve, markEnqueued: vi.fn() }
      } as never,
      queue: {
        enqueue: vi.fn(),
        promoteCharacterEvidence: vi.fn(),
        enqueueCharacterEvidence
      },
      raiderio: { getCharacter: vi.fn() }
    });

    expect(enqueueCharacterEvidence).toHaveBeenCalledWith(
      "evidence-run",
      expect.objectContaining({ priority: 30 })
    );
    expect(reserve).toHaveBeenCalledWith(
      // The applicant is the root of its own discovery.
      expect.objectContaining({ key, origin: "applicant_sheet", root: key })
    );
  });
});

it.each(["active", "fresh"] as const)(
  "applicant reader promotes a joined %s background run and preserves light repairs",
  async (kind) => {
    const run = {
      id: "background-run",
      origin: "refresh",
      status: "queued",
      queueJobId: "background-job" as string | null,
      lightRefresh: true
    };
    const reserve = vi
      .fn()
      .mockImplementation(async () => ({ kind, run, active: run }));
    const queue = {
      enqueue: vi.fn(),
      enqueueCharacterEvidence: vi.fn().mockResolvedValue("repaired-job"),
      promoteCharacterEvidence: vi.fn()
    };
    const markEnqueued = vi.fn();
    const input = {
      key,
      observedAt: new Date(),
      discoveryFreshnessHours: 24,
      evidenceFreshnessHours: 24,
      repositories: {
        suppressions: { isActive: vi.fn().mockResolvedValue(false) },
        searchReservations: {
          reserve: vi.fn().mockResolvedValue({ kind: "fresh" })
        },
        evidence: { reserve, markEnqueued }
      } as never,
      queue,
      raiderio: { getCharacter: vi.fn() }
    };
    await startApplicantCollection(input);
    expect(queue.promoteCharacterEvidence).toHaveBeenCalledWith(
      "background-job",
      30
    );
    expect(queue.enqueueCharacterEvidence).not.toHaveBeenCalled();
    run.queueJobId = null;
    await startApplicantCollection(input);
    expect(queue.enqueueCharacterEvidence).toHaveBeenCalledWith(
      "background-run",
      expect.objectContaining({ mode: "light", priority: 30 })
    );
    expect(run.origin).toBe("refresh");
  }
);
