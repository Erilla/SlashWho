import { describe, expect, it } from "vitest";
import {
  assignGroupIds,
  components,
  familyOf,
  fingerprintDecision,
  pathStrengths,
  raiderIoDecision
} from "./character-connections";

describe("source families", () => {
  it("puts every Raider.IO source in one family and fingerprint in its own", () => {
    expect(familyOf("claimed")).toBe("raiderio");
    expect(familyOf("declared_main")).toBe("raiderio");
    expect(familyOf("profile_guess")).toBe("raiderio");
    expect(familyOf("fingerprint")).toBe("fingerprint");
  });
});

describe("retraction decisions", () => {
  it("replaces Raider.IO links only when Raider.IO answered without a limitation", () => {
    expect(raiderIoDecision(null)).toEqual({
      decision: "replaced",
      reason: "raiderio_complete"
    });
    expect(raiderIoDecision("privacy_hidden")).toEqual({
      decision: "added_only",
      reason: "privacy_hidden"
    });
    expect(raiderIoDecision("request_cap")).toEqual({
      decision: "added_only",
      reason: "raiderio_limited"
    });
  });

  it("replaces fingerprint links only on a full-read match", () => {
    const full = {
      kind: "matched",
      unreadRoot: false,
      skippedHistoricalGuilds: 0
    } as const;
    expect(fingerprintDecision(full)).toEqual({
      decision: "replaced",
      reason: "matched"
    });
    expect(fingerprintDecision({ ...full, kind: "capped" })).toEqual({
      decision: "added_only",
      reason: "capped"
    });
    // Break caught: a capped cycle's skip read as plain `capped`, so the ledger
    // held nothing for the chain's seal to find and honour.
    expect(
      fingerprintDecision({
        ...full,
        kind: "capped",
        skippedHistoricalGuilds: 1
      })
    ).toEqual({
      decision: "added_only",
      reason: "skipped_guild"
    });
    // Break caught: a 404 on the root read as an empty match and cut every link.
    expect(fingerprintDecision({ ...full, unreadRoot: true })).toEqual({
      decision: "added_only",
      reason: "unread"
    });
    expect(
      fingerprintDecision({ ...full, skippedHistoricalGuilds: 2 })
    ).toEqual({
      decision: "added_only",
      reason: "skipped_guild"
    });
  });
});

describe("components", () => {
  it("groups by reach and keeps lone nodes as their own component", () => {
    const parts = components(
      ["a", "b", "c", "d"],
      [
        { a: "a", b: "b" },
        { a: "b", b: "c" }
      ]
    );
    expect(parts).toEqual([["a", "b", "c"], ["d"]]);
  });
});

describe("group id survival", () => {
  const groups = new Map([
    ["g-old", { id: "g-old", createdAt: new Date("2026-09-01T00:00:00Z") }],
    ["g-new", { id: "g-new", createdAt: new Date("2026-09-20T00:00:00Z") }]
  ]);

  it("keeps the oldest id on a merge and deletes the other", () => {
    const membership = new Map([
      ["a", "g-old"],
      ["b", "g-new"]
    ]);
    const result = assignGroupIds([["a", "b"]], membership, groups);
    expect(result.assignments).toEqual([
      { groupId: "g-old", members: ["a", "b"] }
    ]);
    expect(result.deletedGroupIds).toEqual(["g-new"]);
  });

  it("gives the id to the larger part on a split, and a new group to the rest", () => {
    const membership = new Map([
      ["a", "g-old"],
      ["b", "g-old"],
      ["c", "g-old"]
    ]);
    const result = assignGroupIds([["a", "b"], ["c"]], membership, groups);
    expect(result.assignments).toEqual([
      { groupId: "g-old", members: ["a", "b"] },
      { groupId: null, members: ["c"] }
    ]);
    expect(result.deletedGroupIds).toEqual([]);
  });

  it("breaks an even split towards the part holding the lowest character id", () => {
    const membership = new Map([
      ["a", "g-old"],
      ["b", "g-old"]
    ]);
    const result = assignGroupIds([["b"], ["a"]], membership, groups);
    expect(result.assignments).toContainEqual({
      groupId: "g-old",
      members: ["a"]
    });
    expect(result.assignments).toContainEqual({
      groupId: null,
      members: ["b"]
    });
  });
});

describe("path strengths", () => {
  it("labels by the weakest provider link on the strongest path", () => {
    const strengths = pathStrengths("o", [
      { a: "o", b: "f", strength: "fingerprint" },
      { a: "f", b: "c", strength: "raiderio" }
    ]);
    // Break caught: strongest-link-in-group labelled c Raider.IO-declared.
    expect(strengths.get("c")).toBe("fingerprint");
    expect(strengths.get("f")).toBe("fingerprint");
  });

  it("treats manual links as neutral, and a manual-only path as manual", () => {
    const strengths = pathStrengths("o", [
      { a: "o", b: "t", strength: "manual" },
      { a: "t", b: "c", strength: "raiderio" }
    ]);
    expect(strengths.get("t")).toBe("manual");
    expect(strengths.get("c")).toBe("raiderio");
  });

  it("prefers any provider path to a manual-only one", () => {
    const strengths = pathStrengths("o", [
      { a: "o", b: "t", strength: "manual" },
      { a: "o", b: "t", strength: "fingerprint" }
    ]);
    expect(strengths.get("t")).toBe("fingerprint");
  });

  it("does not borrow a stronger label by doubling back through a cut vertex", () => {
    // Break caught: a walk o>t>c>t gave t Raider.IO-declared although t is
    // linked to o only by a manual link.
    const strengths = pathStrengths("o", [
      { a: "o", b: "t", strength: "manual" },
      { a: "t", b: "c", strength: "raiderio" },
      { a: "c", b: "d", strength: "fingerprint" }
    ]);
    expect(strengths.get("t")).toBe("manual");
    expect(strengths.get("c")).toBe("raiderio");
    expect(strengths.get("d")).toBe("fingerprint");
  });

  it("uses any edge of a cycle when a simple path through it exists", () => {
    const strengths = pathStrengths("o", [
      { a: "o", b: "t", strength: "manual" },
      { a: "o", b: "c", strength: "raiderio" },
      { a: "c", b: "t", strength: "raiderio" }
    ]);
    expect(strengths.get("t")).toBe("raiderio");
  });

  it("leaves unreachable nodes out and never labels the origin", () => {
    const strengths = pathStrengths("o", [
      { a: "o", b: "a", strength: "fingerprint" },
      { a: "x", b: "y", strength: "raiderio" }
    ]);
    expect([...strengths.keys()]).toEqual(["a"]);
  });
});
