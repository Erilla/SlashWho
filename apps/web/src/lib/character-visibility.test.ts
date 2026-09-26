import type {
  ApplicantDossier,
  CharacterKey,
  DossierCharacter
} from "@slashwho/contracts";
import { describe, expect, it } from "vitest";

import {
  characterId,
  evidenceFilter,
  filterBoss
} from "./character-visibility";

type Boss = ApplicantDossier["raids"][number]["bosses"][number];

const ryii: CharacterKey = { region: "eu", realm: "silvermoon", name: "ryii" };
const ryalts: CharacterKey = { region: "eu", realm: "draenor", name: "ryalts" };
const formerRyalts: CharacterKey = {
  region: "eu",
  realm: "draenor",
  name: "oldryalts"
};
const excludedAlt: CharacterKey = {
  region: "eu",
  realm: "draenor",
  name: "benched"
};

const characters: DossierCharacter[] = [
  {
    key: ryii,
    displayName: "Ryii",
    className: "Mage",
    raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
    source: "submitted"
  },
  {
    key: ryalts,
    displayName: "Ryalts",
    className: "Priest",
    raiderIoUrl: "https://raider.io/characters/eu/draenor/ryalts",
    historicAliases: [formerRyalts],
    source: "fingerprint_derived"
  },
  {
    key: excludedAlt,
    displayName: "Benched",
    className: "Rogue",
    raiderIoUrl: "https://raider.io/characters/eu/draenor/benched",
    source: "manually_added",
    excluded: true
  }
];

const metadata = {
  bossId: "2602",
  bossName: "Queen Ansurek",
  bossOrder: 8,
  imageUrl: null
};

function parses(character: string) {
  return {
    character,
    damage: { state: "unavailable" as const },
    healing: { state: "not_applicable" as const },
    bossDamage: { state: "unavailable" as const }
  };
}

function kill(killedAt: string, present: CharacterKey[], names: string[]) {
  return {
    killedAt,
    guild: null,
    historicWorldRank: null,
    reportUrl: `https://www.warcraftlogs.com/reports/${killedAt}`,
    characters: present,
    parses: names.map(parses)
  };
}

function wipe(attemptedAt: string, present: CharacterKey[]) {
  return {
    attemptedAt,
    reportUrl: `https://www.warcraftlogs.com/reports/${attemptedAt}`,
    characters: present
  };
}

const hiding = (...keys: CharacterKey[]) =>
  evidenceFilter(characters, new Set(keys.map(characterId)));

describe("evidenceFilter", () => {
  it("filters nothing when no listed character is hidden", () => {
    expect(evidenceFilter(characters, new Set())).toBeNull();
    expect(
      evidenceFilter(
        characters,
        new Set([characterId({ ...ryii, name: "gone" })])
      )
    ).toBeNull();
  });

  it("counts only characters that carry evidence, so excluded ones are left out", () => {
    const filter = hiding(ryalts, excludedAlt);
    expect(filter).toMatchObject({ visibleCount: 1, totalCount: 2 });
  });

  it("matches keys whatever their case", () => {
    const filter = hiding({ region: "eu", realm: "Draenor", name: "Ryalts" });
    expect(filter?.isCharacterVisible(ryalts)).toBe(false);
    expect(filter?.isCharacterVisible(ryii)).toBe(true);
  });

  it("hides evidence recorded under a hidden row's aliases", () => {
    const filter = hiding(ryalts);
    expect(filter?.isCharacterVisible(formerRyalts)).toBe(false);
    expect(filter?.isParseVisible("OldRyalts")).toBe(false);
    expect(filter?.isParseVisible("Ryalts")).toBe(false);
  });

  it("keeps a parse whose name a visible character shares", () => {
    const sameName: DossierCharacter = {
      ...characters[0]!,
      key: { region: "eu", realm: "draenor", name: "ryii" },
      raiderIoUrl: "https://raider.io/characters/eu/draenor/ryii",
      source: "raiderio_declared"
    };
    const filter = evidenceFilter(
      [...characters, sameName],
      new Set([characterId(ryii)])
    );
    expect(filter?.isParseVisible("Ryii")).toBe(true);
  });

  it("leaves characters the list does not hold visible", () => {
    const filter = hiding(ryalts);
    expect(
      filter?.isCharacterVisible({ region: "eu", realm: "x", name: "pug" })
    ).toBe(true);
    expect(filter?.isParseVisible("Pug")).toBe(true);
  });
});

describe("filterBoss", () => {
  const killBoss: Boss = {
    ...metadata,
    state: "kill",
    firstKill: kill("2025-01-10T20:00:00.000Z", [ryalts], ["Ryalts"]),
    firstKills: [
      kill("2025-01-10T20:00:00.000Z", [ryalts], ["Ryalts"]),
      kill("2025-01-14T20:00:00.000Z", [ryii, ryalts], ["Ryii", "Ryalts"])
    ],
    bestParses: [parses("Ryii"), parses("Ryalts")],
    wipes: [
      wipe("2025-01-09T20:00:00.000Z", [ryalts]),
      wipe("2025-01-13T20:00:00.000Z", [ryii, formerRyalts])
    ]
  };

  it("returns the boss untouched when nothing is filtered", () => {
    expect(filterBoss(killBoss, null)).toBe(killBoss);
  });

  it("keeps kills a visible character was present for, without the hidden ones", () => {
    const filtered = filterBoss(killBoss, hiding(ryalts));
    expect(filtered).toMatchObject({
      state: "kill",
      firstKill: {
        killedAt: "2025-01-14T20:00:00.000Z",
        characters: [ryii],
        parses: [{ character: "Ryii" }]
      },
      firstKills: [{ killedAt: "2025-01-14T20:00:00.000Z" }],
      bestParses: [{ character: "Ryii" }],
      wipes: [{ attemptedAt: "2025-01-13T20:00:00.000Z", characters: [ryii] }]
    });
    if (filtered.state !== "kill") throw new Error("expected a kill");
    expect(filtered.firstKills).toHaveLength(1);
    expect(filtered.wipes).toHaveLength(1);
  });

  it("reads as a wipe when the visible characters only wiped", () => {
    const filtered = filterBoss(
      {
        ...killBoss,
        firstKills: [killBoss.firstKill],
        wipes: [wipe("2025-01-13T20:00:00.000Z", [ryii, ryalts])]
      } as Boss,
      hiding(ryalts)
    );
    expect(filtered).toEqual({
      ...metadata,
      state: "wipe",
      wipe: wipe("2025-01-13T20:00:00.000Z", [ryii]),
      wipes: [wipe("2025-01-13T20:00:00.000Z", [ryii])]
    });
  });

  it("marks a boss whose evidence is all hidden as hidden, never as no logs", () => {
    const onlyRyalts: Boss = {
      ...metadata,
      state: "kill",
      firstKill: kill("2025-01-10T20:00:00.000Z", [ryalts], ["Ryalts"]),
      bestParses: [parses("Ryalts")]
    };
    expect(filterBoss(onlyRyalts, hiding(ryalts))).toEqual({
      ...metadata,
      state: "hidden"
    });

    const wipedByRyalts: Boss = {
      ...metadata,
      state: "wipe",
      wipe: wipe("2025-01-09T20:00:00.000Z", [formerRyalts])
    };
    expect(filterBoss(wipedByRyalts, hiding(ryalts))).toEqual({
      ...metadata,
      state: "hidden"
    });
  });

  it("keeps the first remaining wipe as the one a wipe boss leads with", () => {
    const wipeBoss: Boss = {
      ...metadata,
      state: "wipe",
      wipe: wipe("2025-01-13T20:00:00.000Z", [ryalts]),
      wipes: [
        wipe("2025-01-13T20:00:00.000Z", [ryalts]),
        wipe("2025-01-12T20:00:00.000Z", [ryii]),
        wipe("2025-01-11T20:00:00.000Z", [ryii])
      ]
    };
    const filtered = filterBoss(wipeBoss, hiding(ryalts));
    expect(filtered).toMatchObject({
      state: "wipe",
      wipe: { attemptedAt: "2025-01-12T20:00:00.000Z" },
      wipes: [
        { attemptedAt: "2025-01-12T20:00:00.000Z" },
        { attemptedAt: "2025-01-11T20:00:00.000Z" }
      ]
    });
  });

  it("leaves bosses without evidence as they are", () => {
    const noLogs: Boss = { ...metadata, state: "no_logs" };
    const incomplete: Boss = { ...metadata, state: "incomplete" };
    expect(filterBoss(noLogs, hiding(ryalts))).toBe(noLogs);
    expect(filterBoss(incomplete, hiding(ryalts))).toBe(incomplete);
  });
});
