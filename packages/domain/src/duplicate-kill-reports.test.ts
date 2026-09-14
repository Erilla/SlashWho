import { expect, it } from "vitest";
import {
  buildApplicantDossier,
  type DossierKillEvidence
} from "./applicant-dossier";
const character = { region: "eu", realm: "silvermoon", name: "rinn" } as const;
const base: DossierKillEvidence = {
  raidId: "1320",
  raidName: "The Venomous Abyss",
  bossId: "2888",
  bossName: "Nek'zali the Soulcoiler",
  journalBossId: "2888",
  bossOrder: 1,
  isFinalBoss: false,
  character,
  killedAt: "2026-08-23T20:50:12.607Z",
  guild: null,
  historicWorldRank: null,
  reportUrl: "https://www.warcraftlogs.com/reports/dqg8zDNWLA9Rkfca#fight=29"
};
const second: DossierKillEvidence = {
  ...base,
  killedAt: "2026-08-23T20:50:13.386Z",
  guild: { name: "Rancour", realm: "draenor" },
  historicWorldRank: 48,
  reportUrl: "https://www.warcraftlogs.com/reports/PTpjc7XqvGgYR6Mn#fight=27"
};
const third: DossierKillEvidence = {
  ...base,
  killedAt: "2026-08-23T20:50:14.238Z",
  reportUrl: "https://www.warcraftlogs.com/reports/DAHPxvtd7mjXfRNV#fight=30"
};
function events(kills: DossierKillEvidence[]) {
  return buildApplicantDossier({
    root: character,
    characters: [{ key: character, displayName: "Rinn" }],
    kills,
    limitations: []
  }).raids[0]!.bosses[0]!.firstKills;
}
it("combines recorded Nekzali timestamps while retaining guild, rank and all reports", () => {
  const kills = [base, second, third];
  expect(events(kills)).toEqual([
    expect.objectContaining({
      killedAt: base.killedAt,
      guild: second.guild,
      historicWorldRank: 48,
      reportUrls: expect.arrayContaining(kills.map((k) => k.reportUrl)),
      characters: ["Rinn"]
    })
  ]);
  expect(events([...kills].reverse())).toEqual(events(kills));
});
it("groups the full UTC date and starts a new event at midnight", () => {
  const kills = [
    { ...base, killedAt: "2026-08-23T00:00:00.000Z" },
    { ...second, killedAt: "2026-08-23T23:59:59.999Z" },
    { ...third, killedAt: "2026-08-24T00:00:00.000Z" }
  ];
  expect(events(kills).map((k) => k.killedAt)).toEqual([
    kills[0]!.killedAt,
    kills[2]!.killedAt
  ]);
  expect(events([...kills].reverse())).toEqual(events(kills));
});
it.each([
  { guild: { name: "Other", realm: "draenor" } },
  { guild: { name: "Rancour", realm: "silvermoon" } },
  { character: { ...character, name: "unrelated" }, guild: null }
])(
  "groups same-date evidence despite attribution differences: %j",
  (change) => {
    expect(events([second, { ...third, ...change }])).toHaveLength(1);
  }
);
it("keeps evidence from different regions separate", () => {
  expect(
    events([
      second,
      { ...third, character: { ...character, region: "us" as const } }
    ])
  ).toHaveLength(2);
});
it("does not pick an arbitrary conflicting rank and keeps unique links", () => {
  expect(
    events([second, { ...second, historicWorldRank: 49 }, second])
  ).toEqual([
    expect.objectContaining({
      historicWorldRank: null,
      reportUrls: [second.reportUrl]
    })
  ]);
});
it("does not lend a verified first-kill rank to a later reclear", () => {
  expect(
    events([
      base,
      second,
      { ...third, killedAt: "2026-08-30T20:50:14.238Z" }
    ]).map((k) => k.historicWorldRank)
  ).toEqual([48, null]);
});

it("groups same-date participants without requiring a shared report", () => {
  const other = { ...character, name: "ryrn" };
  const kills = [
    { ...base, character: other },
    { ...second, character },
    { ...third, character: other }
  ];
  expect(events(kills)).toHaveLength(1);
  expect(events([...kills].reverse())).toEqual(events(kills));
});
