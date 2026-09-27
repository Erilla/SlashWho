import { describe, expect, it, vi } from "vitest";

import { startApplicantCollection } from "./start-applicant-collection";

const key = { region: "eu" as const, realm: "silvermoon", name: "rinn" };

describe("startApplicantCollection", () => {
  it("reserves evidence as an applicant sheet submission", async () => {
    // Break caught: nothing recorded why a run was queued, so a queue backed
    // up by applicant submissions could not be told from one backed up by
    // readers (#708).
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
        enqueueCharacterEvidence: vi.fn().mockResolvedValue("job-1")
      },
      raiderio: { getCharacter: vi.fn() }
    });

    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ key, origin: "applicant_sheet" })
    );
  });
});
