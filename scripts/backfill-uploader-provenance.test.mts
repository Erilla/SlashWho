import { expect, it } from "vitest";

import {
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
