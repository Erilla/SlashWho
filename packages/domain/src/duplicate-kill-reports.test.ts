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
it("bounds duplicate groups to five seconds without timestamp chaining or same-day merging", () => {
  const kills = [0, 5000, 5001, 10000, 3600000].map((offset, index) => ({
    ...base,
    killedAt: new Date(Date.parse(base.killedAt) + offset).toISOString(),
    reportUrl: `https://www.warcraftlogs.com/reports/r${index}#fight=1`
  }));
  expect(events(kills).map((k) => k.killedAt)).toEqual([
    kills[0]!.killedAt,
    kills[2]!.killedAt,
    kills[4]!.killedAt
  ]);
  expect(events([...kills].reverse())).toEqual(events(kills));
});
it.each([
  { guild: { name: "Other", realm: "draenor" } },
  { guild: { name: "Rancour", realm: "silvermoon" } },
  { character: { ...character, region: "us" as const } },
  { character: { ...character, name: "unrelated" }, guild: null }
])("keeps incompatible evidence separate: %j", (change) => {
  expect(events([second, { ...third, ...change }])).toHaveLength(2);
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

it("merges groups when a shared report supplies the missing participant connection", () => {
  const other = { ...character, name: "ryrn" };
  const kills = [
    { ...base, character: other },
    { ...third, character, reportUrl: second.reportUrl },
    { ...third, character: other, reportUrl: second.reportUrl }
  ];
  expect(events(kills)).toHaveLength(1);
  expect(events([...kills].reverse())).toEqual(events(kills));
});
