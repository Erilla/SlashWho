import { describe, expect, it } from "vitest";
import type { CharacterKey } from "@slashwho/domain";
import { groupBySharedWarcraftLogsId } from "./shared-warcraft-logs-identity";

const ryun: CharacterKey = { region: "eu", realm: "silvermoon", name: "ryun" };
const erilla: CharacterKey = {
  region: "eu",
  realm: "neptulon",
  name: "erilla"
};
const other: CharacterKey = { region: "eu", realm: "silvermoon", name: "ryii" };

const first = <T>(members: readonly T[]) => members[0]!;

describe("groupBySharedWarcraftLogsId", () => {
  it("collapses keys that resolved to one Warcraft Logs character ID", () => {
    const groups = groupBySharedWarcraftLogsId(
      [{ key: ryun }, { key: other }, { key: erilla }],
      [
        { key: ryun, characterId: 40989140 },
        { key: erilla, characterId: 40989140 },
        { key: other, characterId: 7 }
      ],
      first
    );

    expect(groups).toEqual([
      { primary: { key: ryun }, aliases: [{ key: erilla }] },
      { primary: { key: other }, aliases: [] }
    ]);
  });

  it("keeps every key separate when no ID is recorded", () => {
    const groups = groupBySharedWarcraftLogsId(
      [{ key: ryun }, { key: erilla }],
      [],
      first
    );

    expect(groups).toEqual([
      { primary: { key: ryun }, aliases: [] },
      { primary: { key: erilla }, aliases: [] }
    ]);
  });

  it("never merges a key without an ID into one that has one", () => {
    const groups = groupBySharedWarcraftLogsId(
      [{ key: ryun }, { key: erilla }],
      [{ key: ryun, characterId: 40989140 }],
      first
    );

    expect(groups.map((group) => group.aliases)).toEqual([[], []]);
  });

  it("lets the caller choose the primary and keeps the group where its first member ranked", () => {
    const groups = groupBySharedWarcraftLogsId(
      [{ key: ryun }, { key: other }, { key: erilla }],
      [
        { key: ryun, characterId: 40989140 },
        { key: erilla, characterId: 40989140 }
      ],
      (members) =>
        members.find((member) => member.key.name === "erilla") ?? members[0]!
    );

    expect(groups).toEqual([
      { primary: { key: erilla }, aliases: [{ key: ryun }] },
      { primary: { key: other }, aliases: [] }
    ]);
  });

  it("matches recorded keys case-insensitively", () => {
    const groups = groupBySharedWarcraftLogsId(
      [{ key: ryun }, { key: erilla }],
      [
        { key: { ...ryun, name: "Ryun" }, characterId: 40989140 },
        { key: erilla, characterId: 40989140 }
      ],
      first
    );

    expect(groups).toEqual([
      { primary: { key: ryun }, aliases: [{ key: erilla }] }
    ]);
  });
});
