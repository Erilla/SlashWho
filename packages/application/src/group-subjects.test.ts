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
    groupOf: new Map(overrides.names.map((name) => [name, "g"])),
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
});
