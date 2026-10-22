import { readFileSync } from "node:fs";

import type { ApplicantDossier, CharacterKey } from "@slashwho/contracts";
import type { DossierKillEvidence } from "@slashwho/domain";
import { describe, expect, it } from "vitest";

import type {
  StoredDossierEvidence,
  StoredDossierRead
} from "./applicant-dossier-service";
import {
  botDossierState,
  botDossierStatusOf,
  botDossierSummaryOf
} from "./bot-dossier-summary";

const root: CharacterKey = { region: "eu", realm: "silvermoon", name: "ryii" };
const alt: CharacterKey = { region: "eu", realm: "silvermoon", name: "alt" };
const snapshotId = "13af3173-e97c-4c78-a6cb-a54b647b209f";

function evidence(
  key: CharacterKey,
  overrides: Partial<StoredDossierEvidence> = {}
): StoredDossierEvidence {
  return {
    key,
    evidenceState: "complete",
    completedAt: new Date("2026-10-22T09:45:52.977Z"),
    limitations: [],
    ...overrides
  };
}

function dossier(overrides: Partial<ApplicantDossier> = {}): ApplicantDossier {
  return {
    root,
    research: { state: "complete", message: "Complete." },
    characters: [
      {
        key: root,
        displayName: "Ryii",
        className: "Mage",
        guild: { name: "Seriously Casual", region: "eu", realm: "silvermoon" },
        raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
        source: "submitted",
        evidenceState: "complete"
      }
    ],
    raids: [],
    cuttingEdges: [],
    limitations: [],
    lastCollectedAt: "2026-10-22T09:45:52.977Z",
    ...overrides
  };
}

function internalSource(
  source: string
): "submitted" | "manually_added" | "claimed" {
  if (source === "submitted") return "submitted";
  if (source === "manually_added") return "manually_added";
  return "claimed";
}

function read(
  overrides: Partial<Extract<StoredDossierRead, { kind: "ready" }>> = {}
): StoredDossierRead {
  const d = overrides.dossier ?? dossier();
  return {
    kind: "ready",
    dossier: d,
    snapshotId,
    snapshotState: "complete",
    lastCollectedAt: new Date("2026-10-22T09:45:52.977Z"),
    kills: [],
    subjects: d.characters.map((character) => ({
      key: character.key,
      displayName: character.displayName,
      className: character.className,
      guild: character.guild ?? null,
      raiderIoUrl: character.raiderIoUrl,
      source: internalSource(character.source)
    })),
    pendingKeys: [],
    evidence: d.characters.map((character) => evidence(character.key)),
    cuttingEdgesRestored: true,
    evidenceRunIds: [],
    activeDiscovery: false,
    ...overrides
  };
}

function kill(
  key: CharacterKey,
  killedAt: string,
  guild: DossierKillEvidence["guild"],
  raidName = "The Venomous Abyss"
): DossierKillEvidence {
  return {
    raidId: raidName.toLowerCase().replace(/\s+/g, "-"),
    raidName,
    bossId: "boss",
    bossName: "Boss",
    journalBossId: null,
    bossOrder: 1,
    character: key,
    killedAt,
    guild,
    historicWorldRank: null,
    reportUrl: "https://www.warcraftlogs.com/reports/example",
    performance: {
      damage: { state: "unavailable" },
      healing: { state: "unavailable" },
      bossDamage: { state: "unavailable" }
    }
  };
}

const demoDossier = JSON.parse(
  readFileSync(
    new URL(
      "../../../apps/web/src/app/demo/ryii-dossier.json",
      import.meta.url
    ),
    "utf8"
  )
) as ApplicantDossier;

function killsOf(
  demo: ApplicantDossier,
  characterKeys?: readonly CharacterKey[]
): DossierKillEvidence[] {
  return demo.raids.flatMap((raid) =>
    raid.bosses.flatMap((boss) => {
      if (boss.state !== "kill") return [];
      const keys = characterKeys ?? boss.firstKill.characters;
      return keys.map((character) => ({
        raidId: raid.raidId,
        raidName: raid.raidName,
        bossId: boss.bossId,
        bossName: boss.bossName,
        journalBossId: null,
        bossOrder: boss.bossOrder,
        character,
        killedAt: boss.firstKill.killedAt,
        guild: boss.firstKill.guild,
        historicWorldRank: boss.firstKill.historicWorldRank,
        reportUrl: boss.firstKill.reportUrl,
        performance: {
          damage: { state: "unavailable" as const },
          healing: { state: "unavailable" as const },
          bossDamage: { state: "unavailable" as const }
        }
      }));
    })
  );
}

function subjectsOf(demo: ApplicantDossier) {
  return demo.characters
    .filter((character) => character.excluded !== true)
    .map((character) => ({
      key: character.key,
      displayName: character.displayName,
      className: character.className,
      guild: character.guild ?? null,
      raiderIoUrl: character.raiderIoUrl,
      source: internalSource(character.source)
    }));
}

function demoRead(
  demo: ApplicantDossier,
  characterKeys?: readonly CharacterKey[]
): StoredDossierRead {
  const subjects = subjectsOf(demo);
  return {
    kind: "ready",
    dossier: demo,
    snapshotId,
    snapshotState: "complete",
    lastCollectedAt: new Date("2026-10-22T09:45:52.977Z"),
    kills: killsOf(demo, characterKeys),
    subjects,
    pendingKeys: [],
    evidence: subjects.map((subject) => evidence(subject.key)),
    cuttingEdgesRestored: true,
    evidenceRunIds: [],
    activeDiscovery: false
  };
}

describe("botDossierState", () => {
  it("collects before the first snapshot", () => {
    expect(
      botDossierState({
        snapshotId: null,
        snapshotState: null,
        activeDiscovery: false,
        evidenceRunIds: [],
        evidence: [evidence(root)]
      }).state
    ).toBe("collecting");
  });

  it("collects while any discovery run is active", () => {
    expect(
      botDossierState({
        snapshotId,
        snapshotState: "complete",
        activeDiscovery: true,
        evidenceRunIds: [],
        evidence: [evidence(root)]
      }).state
    ).toBe("collecting");
  });

  it("collects while an evidence run is active", () => {
    expect(
      botDossierState({
        snapshotId,
        snapshotState: "complete",
        activeDiscovery: false,
        evidenceRunIds: ["00000000-0000-4000-8000-000000000010"],
        evidence: [evidence(root)]
      }).state
    ).toBe("collecting");
  });

  it("collects while a declared character has no terminal run", () => {
    // A pending manual connection is an included subject with no run. The
    // root's snapshot alone must not let the dossier publish.
    const result = botDossierState({
      snapshotId,
      snapshotState: "complete",
      activeDiscovery: false,
      evidenceRunIds: [],
      evidence: [
        evidence(root),
        evidence(alt, { evidenceState: "waiting", completedAt: null })
      ]
    });
    expect(result.state).toBe("collecting");
    expect(result.lastCollectedAt).toEqual(
      new Date("2026-10-22T09:45:52.977Z")
    );
  });

  it("publishes partial for a privacy-hidden snapshot", () => {
    expect(
      botDossierState({
        snapshotId,
        snapshotState: "partial",
        activeDiscovery: false,
        evidenceRunIds: [],
        evidence: [evidence(root)]
      }).state
    ).toBe("partial");
  });

  it("publishes partial for a terminal partial run", () => {
    expect(
      botDossierState({
        snapshotId,
        snapshotState: "complete",
        activeDiscovery: false,
        evidenceRunIds: [],
        evidence: [evidence(root, { evidenceState: "partial" })]
      }).state
    ).toBe("partial");
  });

  it("publishes ready when every subject is settled", () => {
    expect(
      botDossierState({
        snapshotId,
        snapshotState: "complete",
        activeDiscovery: false,
        evidenceRunIds: [],
        evidence: [evidence(root), evidence(alt)]
      }).state
    ).toBe("ready");
  });
});

describe("botDossierStatusOf", () => {
  it("returns null for an unknown key", () => {
    expect(botDossierStatusOf({ kind: "not_found" })).toBeNull();
  });

  it("returns the same state as the summary for collecting", () => {
    const status = botDossierStatusOf({
      kind: "ok",
      snapshotId: null,
      snapshotState: null,
      lastCollectedAt: null,
      evidence: [
        evidence(root, { evidenceState: "waiting", completedAt: null })
      ],
      evidenceRunIds: [],
      activeDiscovery: true
    });
    expect(status?.state).toBe("collecting");
    expect(status?.snapshotId).toBeNull();
  });
});

describe("botDossierSummaryOf", () => {
  it("shows a pending declared character with no invented class or guild", () => {
    const pending = dossier({
      characters: [
        ...dossier().characters,
        {
          key: alt,
          displayName: "Alt",
          className: null,
          guild: null,
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/alt",
          source: "manually_added",
          evidenceState: "waiting"
        }
      ]
    });
    const summary = botDossierSummaryOf(
      read({
        dossier: pending,
        pendingKeys: [alt],
        evidence: [
          evidence(root),
          evidence(alt, { evidenceState: "waiting", completedAt: null })
        ]
      })
    );
    expect(summary?.state).toBe("collecting");
    expect(summary?.characters[1]).toMatchObject({
      key: alt,
      className: null,
      guild: null,
      source: "manually_added",
      confidence: null,
      evidenceState: "waiting",
      pending: true
    });
  });

  it("omits excluded characters", () => {
    const withExcluded = dossier({
      characters: [
        ...dossier().characters,
        {
          key: alt,
          displayName: "Alt",
          className: "Mage",
          guild: null,
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/alt",
          source: "manually_added",
          excluded: true
        }
      ]
    });
    const summary = botDossierSummaryOf(read({ dossier: withExcluded }));
    expect(summary?.characters.map((character) => character.key)).toEqual([
      root
    ]);
  });

  it("drops a one-night pug and merges a guild rename", () => {
    const summary = botDossierSummaryOf(
      read({
        kills: [
          kill(root, "2026-09-01T20:00:00.000Z", {
            name: "Seriously Casual",
            region: "eu",
            realm: "silvermoon"
          }),
          kill(root, "2026-09-08T20:00:00.000Z", {
            name: "SeriouslyCasual",
            region: "eu",
            realm: "silvermoon"
          }),
          kill(root, "2026-09-15T20:00:00.000Z", {
            name: "One Night Pug",
            region: "eu",
            realm: "silvermoon"
          })
        ]
      })
    );
    expect(summary?.guildHistory).toHaveLength(1);
    expect(summary?.guildHistory[0]).toMatchObject({
      guild: {
        name: "SeriouslyCasual",
        region: "eu",
        realm: "silvermoon"
      },
      firstNight: "2026-09-01",
      lastNight: "2026-09-08",
      raidNights: 2
    });
  });

  it("puts a character in both guilds when it killed with both", () => {
    const summary = botDossierSummaryOf(
      read({
        kills: [
          kill(root, "2026-09-01T20:00:00.000Z", {
            name: "Guild One",
            region: "eu",
            realm: "silvermoon"
          }),
          kill(root, "2026-09-01T21:00:00.000Z", {
            name: "Guild Two",
            region: "eu",
            realm: "silvermoon"
          }),
          kill(root, "2026-09-08T20:00:00.000Z", {
            name: "Guild One",
            region: "eu",
            realm: "silvermoon"
          }),
          kill(root, "2026-09-08T21:00:00.000Z", {
            name: "Guild Two",
            region: "eu",
            realm: "silvermoon"
          })
        ]
      })
    );
    expect(
      summary?.guildHistory.map((entry) => entry.guild.name).sort()
    ).toEqual(["Guild One", "Guild Two"]);
    expect(
      summary?.guildHistory.every((entry) => entry.characters.includes("Ryii"))
    ).toBe(true);
  });

  it("never invents a false cutting edge on a guild stint", () => {
    const summary = botDossierSummaryOf(
      read({
        kills: [
          kill(root, "2026-09-01T20:00:00.000Z", {
            name: "Seriously Casual",
            region: "eu",
            realm: "silvermoon"
          }),
          kill(root, "2026-09-08T20:00:00.000Z", {
            name: "Seriously Casual",
            region: "eu",
            realm: "silvermoon"
          })
        ]
      })
    );
    expect(summary?.guildHistory[0]?.raids[0]).not.toHaveProperty(
      "cuttingEdge"
    );
  });

  it("projects the real five-character demo under 40 KB", () => {
    const summary = botDossierSummaryOf(demoRead(demoDossier));
    expect(summary).not.toBeNull();
    expect(JSON.stringify(summary).length).toBeLessThan(40_000);
  });

  it("projects a two-character slice under 40 KB", () => {
    const keys = demoDossier.characters
      .slice(0, 2)
      .map((character) => character.key);
    const summary = botDossierSummaryOf(demoRead(demoDossier, keys));
    expect(summary).not.toBeNull();
    expect(JSON.stringify(summary).length).toBeLessThan(40_000);
  });

  it("projects a synthetic eight-character worst case under 40 KB", () => {
    // The spec allows a labelled synthetic expansion when a real eight-character
    // capture is not cheap. Every kill names all eight characters, so this is
    // the widest the per-boss character lists can get.
    const keys = Array.from({ length: 8 }, (_, index) => ({
      region: "eu" as const,
      realm: "silvermoon",
      name: `synthetic${index}`
    }));
    const template = demoDossier.characters[0]!;
    const synthetic: ApplicantDossier = {
      ...demoDossier,
      root: keys[0]!,
      characters: keys.map((key) => ({
        ...template,
        key,
        displayName: key.name,
        raiderIoUrl: `https://raider.io/characters/${key.region}/${key.realm}/${key.name}`
      })),
      raids: demoDossier.raids.map((raid) => ({
        ...raid,
        bosses: raid.bosses.map((boss) =>
          boss.state === "kill"
            ? {
                ...boss,
                firstKill: { ...boss.firstKill, characters: keys }
              }
            : boss
        )
      }))
    };
    const summary = botDossierSummaryOf(demoRead(synthetic, keys));
    expect(summary).not.toBeNull();
    expect(JSON.stringify(summary).length).toBeLessThan(40_000);
  });
});
