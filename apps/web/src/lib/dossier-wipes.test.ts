import type { ApplicantDossier } from "@slashwho/contracts";
import { describe, expect, it } from "vitest";

import { compactDossierWipes } from "./dossier-wipes";

type Raid = ApplicantDossier["raids"][number];
type Boss = Raid["bosses"][number];
type WipeEvidence = Extract<Boss, { state: "wipe" }>["wipe"];

const ryii = { region: "eu", realm: "silvermoon", name: "ryii" } as const;
const ryan = { region: "eu", realm: "silvermoon", name: "ryan" } as const;

function wipe(
  attemptedAt: string,
  report: string,
  characters: WipeEvidence["characters"] = [ryii]
): WipeEvidence {
  return {
    attemptedAt,
    reportUrl: `https://www.warcraftlogs.com/reports/${report}`,
    source: "guild_log",
    uploader: null,
    guild: null,
    characters
  };
}

const metadata = {
  bossId: "2602",
  bossName: "Queen Ansurek",
  bossOrder: 8,
  imageUrl: null
};

function dossierWith(boss: Boss): ApplicantDossier {
  return {
    root: ryii,
    research: { state: "complete", message: "" },
    characters: [],
    raids: [
      {
        raidId: "1273",
        raidName: "Nerub-ar Palace",
        imageUrl: null,
        cuttingEdge: null,
        bosses: [boss]
      }
    ],
    cuttingEdges: [],
    limitations: [],
    lastCollectedAt: null
  } as unknown as ApplicantDossier;
}

function wipesOf(dossier: ApplicantDossier): WipeEvidence[] {
  const boss = dossier.raids[0]!.bosses[0]!;
  return boss.state === "kill" || boss.state === "wipe"
    ? [...(boss.wipes ?? [])]
    : [];
}

describe("compactDossierWipes", () => {
  it("folds one night's pulls in one report into its latest pull, keeping every character present", () => {
    // Break caught: a boss with a thousand wiped pulls shipped every pull, a
    // 5 MB dossier for a page that shows one row per night.
    const latest = wipe("2025-01-14T22:40:00.000Z", "abc#fight=30", [ryii]);
    const compacted = compactDossierWipes(
      dossierWith({
        ...metadata,
        state: "wipe",
        wipe: latest,
        wipes: [
          wipe("2025-01-14T20:05:00.000Z", "abc#fight=2", [ryii, ryan]),
          latest,
          wipe("2025-01-14T21:10:00.000Z", "abc#fight=14", [ryii])
        ]
      })
    );

    expect(wipesOf(compacted)).toEqual([
      { ...latest, characters: [ryii, ryan] }
    ]);
  });

  it("keeps separate nights and separate reports apart", () => {
    const compacted = compactDossierWipes(
      dossierWith({
        ...metadata,
        state: "wipe",
        wipe: wipe("2025-01-15T21:00:00.000Z", "abc#fight=4"),
        wipes: [
          wipe("2025-01-14T21:00:00.000Z", "abc#fight=2"),
          wipe("2025-01-14T21:30:00.000Z", "def#fight=5"),
          wipe("2025-01-15T21:00:00.000Z", "abc#fight=4")
        ]
      })
    );

    expect(wipesOf(compacted).map((item) => item.reportUrl)).toEqual([
      "https://www.warcraftlogs.com/reports/abc#fight=4",
      "https://www.warcraftlogs.com/reports/def#fight=5",
      "https://www.warcraftlogs.com/reports/abc#fight=2"
    ]);
  });

  it("does not fold pulls either side of a kill, which the page files under different kills", () => {
    // The page attaches each wipe to the first later kill from another report,
    // so a pull before 21:00 and one after it belong to different kills.
    const kill = (killedAt: string, report: string) => ({
      killedAt,
      guild: null,
      historicWorldRank: null,
      reportUrl: `https://www.warcraftlogs.com/reports/${report}`,
      characters: [ryii],
      parses: []
    });
    const compacted = compactDossierWipes(
      dossierWith({
        ...metadata,
        state: "kill",
        firstKill: kill("2025-01-14T21:00:00.000Z", "alt#fight=9"),
        firstKills: [
          kill("2025-01-14T21:00:00.000Z", "alt#fight=9"),
          kill("2025-01-21T21:00:00.000Z", "main#fight=3")
        ],
        bestParses: [],
        wipes: [
          wipe("2025-01-14T20:00:00.000Z", "main#fight=1"),
          wipe("2025-01-14T20:30:00.000Z", "main#fight=2"),
          wipe("2025-01-14T22:00:00.000Z", "main#fight=7")
        ]
      })
    );

    expect(wipesOf(compacted).map((item) => item.attemptedAt)).toEqual([
      "2025-01-14T22:00:00.000Z",
      "2025-01-14T20:30:00.000Z"
    ]);
  });

  it("leaves kill evidence and the boss's summary wipe untouched", () => {
    const summary = wipe("2025-01-14T20:00:00.000Z", "abc#fight=1");
    const boss: Boss = {
      ...metadata,
      state: "wipe",
      wipe: summary,
      wipes: [summary, wipe("2025-01-14T21:00:00.000Z", "abc#fight=2")]
    };
    const compacted = compactDossierWipes(dossierWith(boss));
    const compactedBoss = compacted.raids[0]!.bosses[0]!;

    expect(compactedBoss.state === "wipe" && compactedBoss.wipe).toBe(summary);
    expect(wipesOf(compacted)).toHaveLength(1);
  });
});
