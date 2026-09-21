import { expect, it } from "vitest";
import {
  buildApplicantDossier,
  type DossierKillEvidence,
  type DossierWipeEvidence
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
  reportUrl: "https://www.warcraftlogs.com/reports/dqg8zDNWLA9Rkfca#fight=29",
  performance: {
    damage: { state: "unavailable" },
    healing: { state: "unavailable" },
    bossDamage: { state: "unavailable" }
  }
};
const second: DossierKillEvidence = {
  ...base,
  killedAt: "2026-08-23T20:50:13.386Z",
  guild: { name: "Rancour", region: "eu", realm: "draenor" },
  historicWorldRank: 48,
  reportUrl: "https://www.warcraftlogs.com/reports/PTpjc7XqvGgYR6Mn#fight=27"
};
const third: DossierKillEvidence = {
  ...base,
  killedAt: "2026-08-23T20:50:14.238Z",
  reportUrl: "https://www.warcraftlogs.com/reports/DAHPxvtd7mjXfRNV#fight=30"
};
function events(kills: DossierKillEvidence[]) {
  const boss = buildApplicantDossier({
    root: character,
    characters: [{ key: character, displayName: "Rinn" }],
    kills,
    limitations: []
  }).raids[0]!.bosses[0]!;
  if (boss.state !== "kill") throw new Error("expected_verified_kill");
  return boss.firstKills;
}
it("combines recorded Nekzali timestamps while retaining guild, rank and all reports", () => {
  const kills = [base, second, third];
  expect(events(kills)).toEqual([
    expect.objectContaining({
      killedAt: base.killedAt,
      guild: second.guild,
      historicWorldRank: 48,
      reportUrls: expect.arrayContaining(kills.map((k) => k.reportUrl)),
      characters: [character]
    })
  ]);
  expect(events([...kills].reverse())).toEqual(events(kills));
});

it("prefers a guild log and preserves the historic report URL order within each source", () => {
  const kills = [
    { ...base, uploader: "Ryiislogs" },
    { ...second, uploader: "Dorian" },
    { ...third, uploader: "Varod" }
  ];

  expect(events(kills)).toMatchObject([
    {
      reportUrl: second.reportUrl,
      reports: [
        {
          reportUrl: second.reportUrl,
          source: "guild_log",
          uploader: "Dorian",
          guild: second.guild
        },
        {
          reportUrl: third.reportUrl,
          source: "personal_log",
          uploader: "Varod",
          guild: null
        },
        {
          reportUrl: base.reportUrl,
          source: "personal_log",
          uploader: "Ryiislogs",
          guild: null
        }
      ]
    }
  ]);
});

it("preserves wipe report source and uploader for the report menu", () => {
  const wipes = [
    {
      raidId: base.raidId,
      raidName: base.raidName,
      bossId: base.bossId,
      bossName: base.bossName,
      journalBossId: base.journalBossId,
      bossOrder: base.bossOrder,
      character,
      attemptedAt: "2026-08-23T20:50:12.607Z",
      reportUrl: base.reportUrl!,
      guild: null,
      uploader: "Ryiislogs"
    },
    {
      raidId: second.raidId,
      raidName: second.raidName,
      bossId: second.bossId,
      bossName: second.bossName,
      journalBossId: second.journalBossId,
      bossOrder: second.bossOrder,
      character,
      attemptedAt: "2026-08-23T20:50:13.386Z",
      reportUrl: second.reportUrl!,
      guild: second.guild,
      uploader: "Dorian"
    }
  ] as (DossierWipeEvidence & {
    guild: DossierKillEvidence["guild"];
    uploader: string;
  })[];

  const raid = buildApplicantDossier({
    root: character,
    characters: [{ key: character, displayName: "Rinn" }],
    kills: [],
    wipes,
    limitations: []
  }).raids.find((entry) => entry.raidId === base.raidId)!;
  const boss = raid.bosses.find((entry) => entry.bossId === base.bossId)!;
  if (boss.state !== "wipe") throw new Error("expected_wipe");

  expect(boss.wipes).toMatchObject([
    {
      reportUrl: second.reportUrl,
      source: "guild_log",
      uploader: "Dorian",
      guild: second.guild
    },
    {
      reportUrl: base.reportUrl,
      source: "personal_log",
      uploader: "Ryiislogs",
      guild: null
    }
  ]);
});
it("groups the full UTC date and starts a new event at midnight", () => {
  const kills = [
    { ...base, killedAt: "2026-08-23T00:00:00.000Z" },
    { ...second, killedAt: "2026-08-23T23:59:59.999Z" },
    { ...third, killedAt: "2026-08-24T00:00:00.000Z" }
  ];
  expect(events(kills).map((k) => k.killedAt)).toEqual([
    kills[2]!.killedAt,
    kills[0]!.killedAt
  ]);
  expect(events([...kills].reverse())).toEqual(events(kills));
});
it.each([
  { guild: { name: "Other", region: "eu" as const, realm: "draenor" } },
  {
    guild: {
      name: "Rancour",
      region: "eu" as const,
      realm: "silvermoon"
    }
  },
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
  ).toEqual([null, 48]);
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
