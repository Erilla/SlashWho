import { describe, expect, it } from "vitest";
import { legacyResolveSubjects } from "./dossier-subjects";

describe("legacyResolveSubjects", () => {
  it("borrows a declared member's snapshot and relabels the root and former root", async () => {
    const root = { region: "eu", realm: "draenor", name: "quellaria" } as const;
    const main = { region: "eu", realm: "draenor", name: "eundariel" } as const;
    const snapshot = {
      id: "s",
      runId: "r",
      rootKey: root,
      state: "complete",
      limitationCode: null,
      refreshedAt: new Date(),
      characterCount: 2,
      characters: [
        {
          key: root,
          displayName: "Q",
          className: "Mage",
          level: 90,
          guild: null,
          raiderIoUrl: "x",
          source: "input",
          characterId: "1",
          displayOrder: 0
        },
        {
          key: main,
          displayName: "E",
          className: "Demon Hunter",
          level: 90,
          guild: null,
          raiderIoUrl: "x",
          source: "declared_main",
          characterId: "2",
          displayOrder: 1
        }
      ]
    };
    const repositories = {
      snapshots: {
        getCurrent: async () => null,
        getCurrentDeclaringCharacter: async () => snapshot
      },
      manualConnections: {
        list: async () => [],
        listDiscoveredExclusions: async () => []
      },
      evidence: { warcraftLogsCharacterIds: async () => [] }
    } as never;
    const resolved = await legacyResolveSubjects(main, repositories, {
      DOSSIER_CHARACTER_CEILING: 50
    });
    expect(resolved?.provisional).toBe(true);
    expect(
      resolved?.selected.map((subject) => [subject.key.name, subject.source])
    ).toEqual([
      ["eundariel", "input"],
      ["quellaria", "claimed"]
    ]);
  });
});
