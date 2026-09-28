import { describe, expect, it } from "vitest";
import type { CharacterKey } from "@slashwho/domain";
import {
  pageMembers,
  resolveGroupSubjects,
  type GroupGraph
} from "./group-subjects";

const key = (name: string): CharacterKey => ({
  region: "eu",
  realm: "draenor",
  name
});

function graph(
  overrides: Partial<GroupGraph> & {
    names: string[];
    links: GroupGraph["links"];
  }
): GroupGraph {
  const characters = new Map(
    overrides.names.map((name) => [
      name,
      {
        key: key(name),
        displayName: name,
        className: "Mage",
        level: 80,
        raiderIoUrl: "x"
      }
    ])
  );
  return {
    characters,
    idOf: (k) => (characters.has(k.name) ? k.name : undefined),
    groupOf:
      overrides.groupOf ?? new Map(overrides.names.map((name) => [name, "g"])),
    links: overrides.links,
    manual: overrides.manual ?? [],
    discoveredExclusions: overrides.discoveredExclusions ?? [],
    suppressed: overrides.suppressed ?? new Set(),
    warcraftLogsIds: overrides.warcraftLogsIds ?? new Map(),
    sharedIdentity: overrides.sharedIdentity ?? ((id) => new Set([id])),
    latestSnapshot: overrides.latestSnapshot ?? new Map()
  };
}

describe("page members", () => {
  it("never walks through a suppressed character", () => {
    const g = graph({
      names: ["o", "s", "x"],
      links: [
        { a: "o", b: "s", strength: "raiderio" },
        { a: "s", b: "x", strength: "raiderio" }
      ],
      suppressed: new Set(["s"])
    });
    expect([...pageMembers("o", g)].sort()).toEqual(["o"]);
  });

  it("returns just the origin when it has no group assignment, without walking ungrouped links", () => {
    // Both ends of the link are absent from `groupOf`. The old code compared
    // `undefined !== undefined`, which is false, so it never skipped the
    // link and walked into `y` anyway. The guard must short-circuit first.
    const g = graph({
      names: ["o", "y"],
      links: [{ a: "o", b: "y", strength: "raiderio" }],
      groupOf: new Map()
    });
    expect([...pageMembers("o", g)]).toEqual(["o"]);
  });
});

describe("resolveGroupSubjects", () => {
  it("labels the opened character as today's root and others by path", () => {
    const g = graph({
      names: ["o", "f", "c"],
      links: [
        { a: "o", b: "f", strength: "fingerprint" },
        { a: "f", b: "c", strength: "raiderio" }
      ]
    });
    const subjects = resolveGroupSubjects(key("o"), g, {
      DOSSIER_CHARACTER_CEILING: 50
    })!;
    expect(
      subjects.selected.map((subject) => [subject.key.name, subject.source])
    ).toEqual([
      ["o", "input"],
      ["c", "fingerprint"],
      ["f", "fingerprint"]
    ]);
  });

  it("greys a character any page member excluded, but never the opened one, and ignores self-exclusions", () => {
    const g = graph({
      names: ["o", "a", "b"],
      links: [
        { a: "o", b: "a", strength: "raiderio" },
        { a: "o", b: "b", strength: "raiderio" }
      ],
      discoveredExclusions: [
        { makerId: "a", targetId: "b" },
        { makerId: "a", targetId: "o" },
        { makerId: "b", targetId: "b" }
      ]
    });
    const subjects = resolveGroupSubjects(key("o"), g, {
      DOSSIER_CHARACTER_CEILING: 50
    })!;
    expect(subjects.excluded.map((subject) => subject.key.name)).toEqual(["b"]);
    expect(subjects.selected.map((subject) => subject.key.name)).toContain("o");
  });

  it("takes research state from page members' snapshots, complete only if O has its own", () => {
    const g = graph({
      names: ["o", "a"],
      links: [{ a: "o", b: "a", strength: "raiderio" }],
      latestSnapshot: new Map([
        ["a", { state: "partial", limitationCode: "privacy_hidden" }]
      ])
    });
    expect(
      resolveGroupSubjects(key("o"), g, { DOSSIER_CHARACTER_CEILING: 50 })!
        .research
    ).toEqual({ state: "partial", limitationCodes: ["privacy_hidden"] });
  });

  it("caps at the ceiling and returns the rest as skipped", () => {
    const g = graph({
      names: ["o", "a", "b"],
      links: [
        { a: "o", b: "a", strength: "raiderio" },
        { a: "o", b: "b", strength: "raiderio" }
      ]
    });
    const subjects = resolveGroupSubjects(key("o"), g, {
      DOSSIER_CHARACTER_CEILING: 2
    })!;
    expect(subjects.selected).toHaveLength(2);
    expect(subjects.skipped).toHaveLength(1);
  });

  it("keeps a character whose only exclusion is a self-exclusion (distinct from the b→b case, which is also excluded by a→b)", () => {
    const g = graph({
      names: ["o", "a", "a2"],
      links: [
        { a: "o", b: "a", strength: "raiderio" },
        { a: "o", b: "a2", strength: "raiderio" }
      ],
      discoveredExclusions: [{ makerId: "a", targetId: "a2" }],
      sharedIdentity: (id) =>
        id === "a" || id === "a2" ? new Set(["a", "a2"]) : new Set([id])
    });
    const subjects = resolveGroupSubjects(key("o"), g, {
      DOSSIER_CHARACTER_CEILING: 50
    })!;
    expect(subjects.excluded).toEqual([]);
    expect(subjects.selected.map((subject) => subject.key.name)).toContain(
      "a2"
    );
  });

  it("marks research complete when every page member's latest snapshot is complete, including O's own", () => {
    const g = graph({
      names: ["o", "a"],
      links: [{ a: "o", b: "a", strength: "raiderio" }],
      latestSnapshot: new Map([
        ["o", { state: "complete", limitationCode: null }],
        ["a", { state: "complete", limitationCode: null }]
      ])
    });
    expect(
      resolveGroupSubjects(key("o"), g, { DOSSIER_CHARACTER_CEILING: 50 })!
        .research
    ).toEqual({ state: "complete", limitationCodes: [] });
  });

  it("marks research partial when O is complete but another page member is partial, surfacing that member's code", () => {
    const g = graph({
      names: ["o", "a"],
      links: [{ a: "o", b: "a", strength: "raiderio" }],
      latestSnapshot: new Map([
        ["o", { state: "complete", limitationCode: null }],
        ["a", { state: "partial", limitationCode: "privacy_hidden" }]
      ])
    });
    expect(
      resolveGroupSubjects(key("o"), g, { DOSSIER_CHARACTER_CEILING: 50 })!
        .research
    ).toEqual({ state: "partial", limitationCodes: ["privacy_hidden"] });
  });

  it("labels a Raider.IO path as claimed", () => {
    const g = graph({
      names: ["o", "a"],
      links: [{ a: "o", b: "a", strength: "raiderio" }]
    });
    const subjects = resolveGroupSubjects(key("o"), g, {
      DOSSIER_CHARACTER_CEILING: 50
    })!;
    expect(
      subjects.selected.find((subject) => subject.key.name === "a")?.source
    ).toBe("claimed");
  });

  it("labels a manual-only path as manually_added", () => {
    const g = graph({
      names: ["o", "a"],
      links: [{ a: "o", b: "a", strength: "manual" }]
    });
    const subjects = resolveGroupSubjects(key("o"), g, {
      DOSSIER_CHARACTER_CEILING: 50
    })!;
    expect(
      subjects.selected.find((subject) => subject.key.name === "a")?.source
    ).toBe("manually_added");
  });

  it("labels a character reached through a fingerprint bridge, not a raiderio path blocked by a suppressed character", () => {
    // o-s-x is all raiderio, but s is suppressed, so that path is blocked.
    // o-x is a direct fingerprint link. A regression that hands
    // `pathStrengths` the whole, unfiltered link list (rather than the
    // links filtered down to page members) would still see the o-s-x
    // raiderio path and mislabel x "raiderio".
    const g = graph({
      names: ["o", "s", "x"],
      links: [
        { a: "o", b: "s", strength: "raiderio" },
        { a: "s", b: "x", strength: "raiderio" },
        { a: "o", b: "x", strength: "fingerprint" }
      ],
      suppressed: new Set(["s"])
    });
    const subjects = resolveGroupSubjects(key("o"), g, {
      DOSSIER_CHARACTER_CEILING: 50
    })!;
    expect(subjects.selected.map((subject) => subject.key.name)).not.toContain(
      "s"
    );
    expect(
      subjects.selected.find((subject) => subject.key.name === "x")?.source
    ).toBe("fingerprint");
  });

  it("ignores exclusions made by a non-member, whether suppressed directly or unreachable behind a suppressed bridge", () => {
    // "s" is suppressed outright. "m" is reachable only through "s", so it
    // never becomes a page member either. Neither's exclusion should count.
    const g = graph({
      names: ["o", "s", "m", "y", "z"],
      links: [
        { a: "o", b: "s", strength: "raiderio" },
        { a: "s", b: "m", strength: "raiderio" },
        { a: "o", b: "y", strength: "raiderio" },
        { a: "o", b: "z", strength: "raiderio" }
      ],
      suppressed: new Set(["s"]),
      discoveredExclusions: [{ makerId: "s", targetId: "y" }],
      manual: [{ makerId: "m", targetId: "z", excluded: true }]
    });
    const subjects = resolveGroupSubjects(key("o"), g, {
      DOSSIER_CHARACTER_CEILING: 50
    })!;
    expect(subjects.excluded).toEqual([]);
    expect(subjects.selected.map((subject) => subject.key.name).sort()).toEqual(
      ["o", "y", "z"]
    );
  });

  it("groups two members sharing a Warcraft Logs id, excluding the pair under the excluded key as primary (matching legacy)", () => {
    const g = graph({
      names: ["o", "a", "b"],
      links: [
        { a: "o", b: "a", strength: "raiderio" },
        { a: "o", b: "b", strength: "raiderio" }
      ],
      warcraftLogsIds: new Map([
        ["a", 555],
        ["b", 555]
      ]),
      discoveredExclusions: [{ makerId: "o", targetId: "b" }]
    });
    const subjects = resolveGroupSubjects(key("o"), g, {
      DOSSIER_CHARACTER_CEILING: 50
    })!;
    expect(subjects.excluded).toHaveLength(1);
    expect(subjects.excluded[0]?.key.name).toBe("b");
    expect(
      subjects.excluded[0]?.warcraftLogsAliases?.map((alias) => alias.name)
    ).toEqual(["a"]);
    expect(subjects.selected.map((subject) => subject.key.name)).toEqual(["o"]);
  });

  it("keeps O selected as primary when it shares a Warcraft Logs id with an excluded alias", () => {
    const g = graph({
      names: ["o", "a"],
      links: [{ a: "o", b: "a", strength: "raiderio" }],
      warcraftLogsIds: new Map([
        ["o", 777],
        ["a", 777]
      ]),
      discoveredExclusions: [{ makerId: "o", targetId: "a" }]
    });
    const subjects = resolveGroupSubjects(key("o"), g, {
      DOSSIER_CHARACTER_CEILING: 50
    })!;
    expect(subjects.excluded).toEqual([]);
    expect(subjects.selected).toHaveLength(1);
    expect(subjects.selected[0]?.key.name).toBe("o");
    expect(
      subjects.selected[0]?.warcraftLogsAliases?.map((alias) => alias.name)
    ).toEqual(["a"]);
  });
});
