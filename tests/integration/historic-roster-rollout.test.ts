import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { buildApplicantDossier } from "@slashwho/domain";
import type { RaiderIoGateway } from "../../packages/raiderio/src";

import { createApplicantEvidenceJobHandler } from "../../packages/application/src/applicant-evidence-job-handler";
import { dossierRaiderIoFirstKill } from "../../packages/application/src/raiderio-first-kill-evidence";
import { staleReadNeedsOnlyNewestPage } from "../../packages/application/src/settled-collection";
import {
  resetRepositoryTables,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";

const key = { region: "eu", realm: "silvermoon", name: "sentinel" } as const;
const day = 24 * 60 * 60 * 1000;
const seedAt = new Date("2026-09-25T12:00:00Z");
const killAt = "2022-05-20T20:10:00.000Z";

let pool: Pool;
let stop: (() => Promise<void>) | undefined;
let repositories: TestRepositories;
beforeAll(async () => {
  ({ pool, stop, repositories } = await startRepositoryDatabase());
});
afterAll(async () => {
  await stop?.();
});
beforeEach(async () => {
  await resetRepositoryTables(pool);
  await pool.query("TRUNCATE raiderio_roster_profile_resolutions");
});

it("keeps old completed evidence fresh, uses a light run within the week, then recovers the historic roster on an ordinary full run", async () => {
  let at = seedAt;
  let offerHistoricKill = false;
  const getHistoricMythicKills = vi.fn<
    RaiderIoGateway["getHistoricMythicKills"]
  >(async (_key, options) => ({
    kind: "evidence",
    kills:
      offerHistoricKill && options.tierOrdinals.includes(28)
        ? [
            {
              raidSlug: "sepulcher-of-the-first-ones",
              bossSlug: "the-jailer",
              firstDefeated: killAt,
              guild: null,
              loggedEncounterId: 700001
            }
          ]
        : []
  }));
  const resolveRosterProfile = vi.fn<RaiderIoGateway["resolveRosterProfile"]>(
    async (_locator, _signal, physical) => {
      physical?.();
      return { kind: "resolved", characterId: 456 };
    }
  );
  const raiderio: RaiderIoGateway = {
    getHistoricMythicKills,
    resolveRosterProfile,
    async getCharacter() {
      return {
        key,
        displayName: "Sentinel",
        className: "Mage",
        level: 80,
        guild: null,
        ownerId: null,
        profileGuess: null,
        declaredMain: null,
        raiderIoCharacterId: 456
      };
    },
    async getClaimedCharacters() {
      return { characters: [] };
    },
    async resolveProfileGuess() {
      return null;
    },
    async getMythicBossRankings() {
      return { kind: "rankings", rows: [] };
    },
    async getLoggedEncounter() {
      return {
        kind: "encounter",
        raidSlug: "sepulcher-of-the-first-ones",
        bossSlug: "the-jailer",
        pulledAt: "2022-05-20T20:00:00.000Z",
        defeatedAt: killAt,
        durationMs: 600000,
        guild: null,
        itemLevel: { average: 275, min: 270, max: 280 },
        deathCount: 0,
        vantusCount: null,
        shareRaidUntil: null,
        roster: {
          state: "available",
          members: [
            {
              raiderIoCharacterId: 123,
              name: "former-123",
              realm: "argent-dawn",
              region: "eu",
              className: "Mage",
              specName: "Fire",
              role: "dps",
              itemLevel: 275
            }
          ]
        }
      };
    }
  };
  // An unrelated, settled WCL tier gives the existing scan-floor policy its
  // terminal boundary. The historical Jailer kill itself has no WCL report.
  const baseline = {
    raidId: "38",
    raidName: "Amirdrassil, the Dream's Hope",
    bossId: "2677",
    bossName: "Fyrakk the Blazing",
    journalBossId: "2519",
    bossOrder: 9,
    killedAt: "2024-01-20T20:00:00.000Z",
    reportCode: "fixture",
    fightId: 1,
    difficulty: 5,
    reportUrl: "https://www.warcraftlogs.com/reports/fixture",
    fightUrl: "https://www.warcraftlogs.com/reports/fixture#fight=1",
    guild: null,
    performance: {
      damage: { state: "unavailable" as const },
      healing: { state: "unavailable" as const },
      bossDamage: { state: "unavailable" as const }
    }
  };
  const getFirstKillReports = vi.fn(async () => ({
    kind: "evidence" as const,
    kills: offerHistoricKill ? [] : [baseline],
    wipes: [],
    tierBests: offerHistoricKill
      ? []
      : [
          {
            raidId: baseline.raidId,
            raidName: baseline.raidName,
            bossId: baseline.bossId,
            bossName: baseline.bossName,
            rankingsUrl:
              "https://www.warcraftlogs.com/character/eu/silvermoon/sentinel",
            performance: baseline.performance
          }
        ],
    parsedFightUrls: offerHistoricKill ? [] : [baseline.fightUrl],
    troubledRaidIds: { parses: [], tierBests: [] }
  }));
  const handler = createApplicantEvidenceJobHandler({
    evidence: repositories.evidence,
    raiderio,
    warcraftLogs: {
      getFirstKillReports,
      async getRateLimit() {
        return {
          kind: "rate_limit",
          limitPerHour: 18000,
          pointsSpentThisHour: 0,
          pointsResetInSeconds: 900
        };
      }
    },
    now: () => at,
    requestCap: 500,
    parseRequestCap: 24,
    pointsReserve: 0,
    capRetryMs: 1800000,
    transientRetryMs: 900000,
    killSettleMs: 7 * day,
    retryCostCeiling: 250,
    failureCooldownMs: 1800000
  });
  const reserve = () =>
    repositories.evidence.reserve({
      origin: "dossier_read",
      key,
      at,
      freshnessCutoff: new Date(at.getTime() - day)
    });
  const seed = await reserve();
  if (seed.kind !== "reserved") throw new Error("seed_not_reserved");
  await handler.execute(seed.run.id);
  expect((await repositories.evidence.find(seed.run.id))?.status).toBe(
    "complete"
  );
  expect(await repositories.evidence.lastRaiderIoRecoveryAt(key)).toEqual(
    seedAt
  );
  await pool.query(
    `INSERT INTO character_raiderio_tier_reads
    (region, realm_slug, normalized_name, tier_ordinal, collection_version, read_at)
    VALUES ($1, $2, $3, 28, 1, $4)
    ON CONFLICT (region, realm_slug, normalized_name, tier_ordinal)
    DO UPDATE SET collection_version = 1, read_at = EXCLUDED.read_at`,
    [key.region, key.realm, key.name, seedAt]
  );
  getHistoricMythicKills.mockClear();
  getFirstKillReports.mockClear();
  offerHistoricKill = true;

  at = new Date("2026-09-25T18:00:00Z");
  expect((await reserve()).kind).toBe("fresh");
  expect(getHistoricMythicKills).not.toHaveBeenCalled();
  expect(resolveRosterProfile).not.toHaveBeenCalled();

  at = new Date("2026-09-27T12:00:00Z");
  const light = await reserve();
  if (light.kind !== "reserved") throw new Error("light_not_reserved");
  expect(
    await staleReadNeedsOnlyNewestPage({
      key,
      at,
      completed: light.completed,
      completedVersionCurrent: light.completedVersionCurrent ?? false,
      evidence: repositories.evidence
    })
  ).toBe(true);
  await repositories.evidence.markLightRefresh(light.run.id);
  await handler.execute({ runId: light.run.id, mode: "light" });
  expect((await repositories.evidence.find(light.run.id))?.status).toBe(
    "complete"
  );
  expect(getHistoricMythicKills).not.toHaveBeenCalled();
  expect(resolveRosterProfile).not.toHaveBeenCalled();
  expect(await repositories.evidence.lastRaiderIoRecoveryAt(key)).toEqual(
    seedAt
  );
  expect(
    (
      await pool.query(
        `SELECT collection_version FROM character_raiderio_tier_reads WHERE tier_ordinal = 28`
      )
    ).rows
  ).toEqual([{ collection_version: 1 }]);

  at = new Date("2026-10-03T12:00:00Z");
  const full = await reserve();
  if (full.kind !== "reserved") throw new Error("full_not_reserved");
  expect(
    await staleReadNeedsOnlyNewestPage({
      key,
      at,
      completed: full.completed,
      completedVersionCurrent: full.completedVersionCurrent ?? false,
      evidence: repositories.evidence
    })
  ).toBe(false);
  await handler.execute(full.run.id);
  expect(getHistoricMythicKills.mock.calls[0]?.[1].tierOrdinals).toContain(28);
  expect(resolveRosterProfile).toHaveBeenCalledExactlyOnceWith(
    { region: "eu", realm: "argent-dawn", name: "former-123", historicId: 123 },
    expect.any(AbortSignal),
    expect.any(Function)
  );
  const completed = (await reserve()).completed;
  expect(completed?.run.status).toBe("complete");
  expect(completed?.kills.every((kill) => kill.bossName !== "The Jailer")).toBe(
    true
  );
  expect(completed?.raiderIoFirstKills).toHaveLength(1);
  expect(completed?.raiderIoFirstKills?.[0]).toMatchObject({
    presenceChecked: true,
    encounterState: "read"
  });
  expect(
    (
      await pool.query(
        `SELECT collection_version FROM character_raiderio_tier_reads WHERE tier_ordinal = 28`
      )
    ).rows
  ).toEqual([{ collection_version: 2 }]);
  const dossier = buildApplicantDossier({
    root: key,
    characters: [
      {
        key,
        displayName: "Sentinel",
        className: "Mage",
        raiderIoUrl: "https://raider.io/characters/eu/silvermoon/sentinel"
      }
    ],
    kills: [],
    raiderIoFirstKills: completed!.raiderIoFirstKills!.map((kill) =>
      dossierRaiderIoFirstKill(kill, key)
    ),
    limitations: []
  });
  const jailer = dossier.raids
    .flatMap((raid) => raid.bosses)
    .find((boss) => boss.bossName === "The Jailer");
  expect(jailer?.state).toBe("kill");
  if (jailer?.state !== "kill") throw new Error("historic_kill_missing");
  expect(jailer.firstKill).toMatchObject({
    reportUrl: null,
    reports: [],
    parses: [],
    characters: [key],
    roster: {
      state: "available",
      members: [
        { name: "former-123", realm: "argent-dawn", isDossierCharacter: false }
      ]
    }
  });
});

it.each(["private", "not_found", "save_failed"] as const)(
  "retains previously published unproved evidence when a visible historical roster resolution is %s",
  async (outcome) => {
    const at = new Date("2026-10-03T12:00:00Z");
    const historicKill = {
      raidSlug: "sepulcher-of-the-first-ones",
      bossSlug: "the-jailer",
      firstDefeated: killAt,
      guild: null,
      loggedEncounterId: 700002
    };
    const encounter = {
      loggedEncounterId: 700002,
      raidSlug: historicKill.raidSlug,
      bossSlug: historicKill.bossSlug,
      pulledAt: "2022-05-20T20:00:00.000Z",
      defeatedAt: killAt,
      durationMs: 600000,
      guild: null,
      itemLevel: { average: 275, min: 270, max: 280 },
      deathCount: 0,
      vantusCount: null,
      shareRaidUntil: null,
      rosterState: "private" as const,
      members: []
    };
    await repositories.evidence.saveRaiderIoLoggedEncounters!(
      { encounters: [encounter], unavailable: [] },
      seedAt
    );
    const seed = await repositories.evidence.reserve({
      origin: "dossier_read",
      key,
      at: seedAt,
      freshnessCutoff: new Date(seedAt.getTime() - day)
    });
    if (seed.kind !== "reserved") throw new Error("seed_not_reserved");
    await repositories.evidence.publish(seed.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: seedAt,
      raiderIoFirstKills: {
        askedRaidSlugs: [historicKill.raidSlug],
        limitationCode: null,
        kills: [
          {
            raidSlug: historicKill.raidSlug,
            bossSlug: historicKill.bossSlug,
            killedAt: killAt,
            guild: null,
            loggedEncounterId: 700002,
            encounterState: "read",
            encounterLimitationCode: null,
            presenceChecked: false,
            historicWorldRank: null,
            historicRankCheckedAt: seedAt.toISOString()
          }
        ]
      }
    });
    await pool.query(
      `INSERT INTO character_raiderio_tier_reads
      (region, realm_slug, normalized_name, tier_ordinal, collection_version, read_at)
      VALUES ($1, $2, $3, 28, 1, $4)`,
      [key.region, key.realm, key.name, seedAt]
    );
    const reservation = await repositories.evidence.reserve({
      origin: "dossier_read",
      key,
      at,
      freshnessCutoff: new Date(at.getTime() - day)
    });
    if (reservation.kind !== "reserved")
      throw new Error("refresh_not_reserved");
    const resolveRosterProfile = vi.fn<RaiderIoGateway["resolveRosterProfile"]>(
      async () =>
        outcome === "save_failed"
          ? { kind: "resolved", characterId: 456 }
          : { kind: "limitation", code: outcome }
    );
    const answer = vi.fn(async () => false);
    const evidence =
      outcome === "save_failed"
        ? {
            ...repositories.evidence,
            rosterProfileResolutions: {
              ...repositories.evidence.rosterProfileResolutions!,
              answer
            }
          }
        : repositories.evidence;
    await createApplicantEvidenceJobHandler({
      evidence,
      raiderio: {
        async getCharacter() {
          return {
            key,
            displayName: "Sentinel",
            className: "Mage",
            level: 80,
            guild: null,
            ownerId: null,
            profileGuess: null,
            declaredMain: null,
            raiderIoCharacterId: 456
          };
        },
        async getHistoricMythicKills() {
          return { kind: "evidence", kills: [historicKill] };
        },
        async getLoggedEncounter() {
          return {
            ...encounter,
            kind: "encounter",
            roster: {
              state: "available",
              members: [
                {
                  raiderIoCharacterId: 123,
                  name: "former-123",
                  realm: "argent-dawn",
                  region: "eu",
                  className: "Mage",
                  specName: "Fire",
                  role: "dps",
                  itemLevel: 275
                }
              ]
            }
          };
        },
        resolveRosterProfile,
        async getMythicBossRankings() {
          return { kind: "rankings", rows: [] };
        },
        async getClaimedCharacters() {
          return { characters: [] };
        },
        async resolveProfileGuess() {
          return null;
        }
      },
      warcraftLogs: {
        async getRateLimit() {
          return {
            kind: "rate_limit",
            limitPerHour: 18000,
            pointsSpentThisHour: 0,
            pointsResetInSeconds: 900
          };
        },
        async getFirstKillReports() {
          return {
            kind: "evidence",
            kills: [],
            wipes: [],
            tierBests: [],
            parsedFightUrls: [],
            troubledRaidIds: { parses: [], tierBests: [] }
          };
        }
      },
      now: () => at,
      requestCap: 500,
      parseRequestCap: 24,
      pointsReserve: 0,
      capRetryMs: 1800000,
      transientRetryMs: 900000,
      killSettleMs: 7 * day,
      retryCostCeiling: 250,
      failureCooldownMs: 1800000
    }).execute(reservation.run.id);
    expect(resolveRosterProfile).toHaveBeenCalledTimes(1);
    if (outcome === "save_failed") expect(answer).toHaveBeenCalledTimes(1);
    const readback = await repositories.evidence.reserve({
      origin: "dossier_read",
      key,
      at,
      freshnessCutoff: new Date(at.getTime() - day)
    });
    expect(readback.kind).toBe("fresh");
    expect(readback.completed?.run.status).toBe("partial");
    expect(readback.completed?.raiderIoFirstKills).toHaveLength(1);
    expect(readback.completed?.raiderIoFirstKills?.[0]).toMatchObject({
      loggedEncounterId: 700002,
      encounterState: "read",
      presenceChecked: false
    });
    expect(
      (
        await pool.query(
          `SELECT retry_after_at FROM character_evidence_runs WHERE id = $1`,
          [reservation.run.id]
        )
      ).rows
    ).toEqual([{ retry_after_at: null }]);
    expect(
      (
        await pool.query(
          `SELECT collection_version FROM character_raiderio_tier_reads WHERE tier_ordinal = 28`
        )
      ).rows
    ).toEqual([{ collection_version: 1 }]);
  }
);
