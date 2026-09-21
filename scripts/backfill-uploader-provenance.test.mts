import { expect, it, vi } from "vitest";

import {
  createUploaderProvenanceBackfillDependencies,
  parseUploaderProvenanceBackfillOperation,
  runUploaderProvenanceBackfill
} from "./backfill-uploader-provenance.mts";

it("requires an explicitly bounded, paced uploader-provenance backfill", () => {
  // Break caught: removing either confirmation lets a copied command enqueue an
  // unreviewed cohort or burst work into the shared collection queue.
  expect(
    parseUploaderProvenanceBackfillOperation([
      "--",
      "--input",
      "issue-410.urls",
      "--interval-ms",
      "60000",
      "--limit",
      "59"
    ])
  ).toEqual({
    inputPath: "issue-410.urls",
    intervalMs: 60_000,
    limit: 59
  });

  expect(() => parseUploaderProvenanceBackfillOperation([])).toThrow(
    "backfill_input_required"
  );
  expect(() =>
    parseUploaderProvenanceBackfillOperation([
      "--input",
      "issue-410.urls",
      "--interval-ms",
      "999",
      "--limit",
      "59"
    ])
  ).toThrow("backfill_interval_invalid");
  expect(() =>
    parseUploaderProvenanceBackfillOperation([
      "--input",
      "issue-410.urls",
      "--interval-ms",
      "60000",
      "--limit",
      "0"
    ])
  ).toThrow("backfill_limit_invalid");
});

it("spaces each rebuild after the previous one", async () => {
  // Break caught: starting all rebuilds together bypasses the operator pacing
  // guard and needlessly fills the shared evidence queue.
  const events: string[] = [];

  await expect(
    runUploaderProvenanceBackfill(
      [
        "https://raider.io/characters/eu/silvermoon/Ryii",
        "https://raider.io/characters/eu/silvermoon/Ryan"
      ],
      { intervalMs: 60_000, limit: 2 },
      {
        rebuild: async (characterUrl) => {
          events.push(`rebuild:${characterUrl}`);
        },
        sleep: async (milliseconds) => {
          events.push(`sleep:${milliseconds}`);
        }
      }
    )
  ).resolves.toEqual({ scheduled: 2 });

  expect(events).toEqual([
    "rebuild:https://raider.io/characters/eu/silvermoon/Ryii",
    "sleep:60000",
    "rebuild:https://raider.io/characters/eu/silvermoon/Ryan"
  ]);
});

it("refuses an input that exceeds the operator-approved limit", async () => {
  // Break caught: a changed or malformed input file could otherwise turn a
  // targeted repair into a broad historical re-collection.
  const rebuild = async () => {
    throw new Error("rebuild_must_not_run");
  };

  await expect(
    runUploaderProvenanceBackfill(
      [
        "https://raider.io/characters/eu/silvermoon/Ryii",
        "https://raider.io/characters/eu/silvermoon/Ryan"
      ],
      { intervalMs: 60_000, limit: 1 },
      { rebuild, sleep: async () => {} }
    )
  ).rejects.toThrow("backfill_limit_exceeded");
});

it("uses a rebuild to clear terminal tiers before queuing the targeted history scan", async () => {
  // Break caught: replacing the provenance repair with an ordinary refresh
  // leaves terminal tiers intact, so the worker skips the historical reports
  // whose Warcraft Logs owners need to be re-read.
  const key = { region: "eu" as const, realm: "silvermoon", name: "ryii" };
  const clearTerminalTiers = vi.fn().mockResolvedValue(3);
  const enqueueCharacterEvidence = vi.fn().mockResolvedValue("job-1");
  const markEnqueued = vi.fn().mockResolvedValue(undefined);

  await runUploaderProvenanceBackfill(
    ["https://raider.io/characters/eu/silvermoon/Ryii"],
    { intervalMs: 60_000, limit: 1 },
    createUploaderProvenanceBackfillDependencies({
      now: () => new Date("2026-09-21T14:00:00.000Z"),
      repositories: {
        evidence: {
          getCompleted: vi.fn().mockResolvedValue(null),
          clearTerminalTiers,
          reserve: vi.fn().mockResolvedValue({
            kind: "reserved",
            run: { id: "run-1", key, status: "queued" }
          }),
          markEnqueued
        }
      } as never,
      queue: { enqueueCharacterEvidence } as never,
      sleep: async () => {}
    })
  );

  expect(clearTerminalTiers).toHaveBeenCalledWith(key);
  expect(enqueueCharacterEvidence).toHaveBeenCalledWith(
    "run-1",
    expect.objectContaining({ mode: "full" })
  );
});

it("stops when a rebuild fails instead of scheduling the remaining input", async () => {
  // Break caught: continuing after a failed target makes the operator lose the
  // reviewed boundary between an investigated failure and the remaining work.
  const rebuild = vi
    .fn()
    .mockRejectedValueOnce(new Error("rebuild_failed"))
    .mockResolvedValue(undefined);

  await expect(
    runUploaderProvenanceBackfill(
      [
        "https://raider.io/characters/eu/silvermoon/Ryii",
        "https://raider.io/characters/eu/silvermoon/Ryan"
      ],
      { intervalMs: 60_000, limit: 2 },
      { rebuild, sleep: async () => {} }
    )
  ).rejects.toThrow("rebuild_failed");

  expect(rebuild).toHaveBeenCalledTimes(1);
});
