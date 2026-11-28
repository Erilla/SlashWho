import { describe, expect, it } from "vitest";
import * as freshness from "./group-freshness";

describe("group freshness", () => {
  it("uses complete run times with a strict cutoff", () => {
    const at = new Date("2026-10-13T12:00:00Z");
    expect(freshness.isFresh([], at, 24)).toBe(false);
    expect(freshness.isFresh([new Date("2026-10-12T12:00:01Z")], at, 24)).toBe(
      true
    );
    expect(freshness.isFresh([new Date("2026-10-12T12:00:00Z")], at, 24)).toBe(
      false
    );
  });
  it("backs off consecutive failures, capped at sweep cadence", () => {
    const at = new Date("2026-10-13T12:00:00Z");
    const failed = {
      status: "failed",
      completedAt: new Date("2026-10-12T00:00:00Z"),
      createdAt: new Date("2026-10-12T00:00:00Z")
    };
    expect(freshness.hasFailureBackoff([failed], at, 24, 168)).toBe(false);
    expect(freshness.hasFailureBackoff([failed, failed], at, 24, 168)).toBe(
      true
    );
    expect(
      freshness.hasFailureBackoff(
        [{ ...failed, status: "complete", createdAt: at }, failed],
        at,
        24,
        168
      )
    ).toBe(false);
  });
  it("allows abandoned cursors but blocks resumable cursors and active runs", () => {
    const key = { region: "eu", realm: "silvermoon", name: "ryii" } as const;
    const cutoff = new Date("2026-10-01T00:00:00Z");
    const state = {
      key,
      lastPublishedAt: null,
      resumeAfter: "cursor",
      continuationFailures: 4
    };
    expect(freshness.isSweepDue([state], [], cutoff, 5)).toBe(false);
    expect(
      freshness.isSweepDue(
        [{ ...state, continuationFailures: 5 }],
        [],
        cutoff,
        5
      )
    ).toBe(true);
    expect(
      freshness.isSweepDue(
        [],
        [{ status: "queued", completedAt: null, createdAt: cutoff }],
        cutoff,
        5
      )
    ).toBe(false);
  });
});
