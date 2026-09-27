/**
 * Synthetic completed evidence at a chosen volume, for the dossier load
 * profiler's production-sized scenarios (#686). Every value is generated:
 * raids, bosses and Cutting Edge achievements come from the catalogues, and
 * guilds, uploaders and report codes are made up. Nothing here is read from,
 * or shaped like, any real character's rows.
 *
 * Kept apart from `seed.ts`, which needs a database, so the shape is unit
 * tested.
 */
import {
  lookupRaidCurrentContentWindow,
  supportedRaidCatalogue
} from "@slashwho/domain";
import type {
  CharacterCuttingEdgeInput,
  CharacterMythicKillInput,
  CharacterMythicWipeInput,
  CharacterTierBestParseInput
} from "@slashwho/database";

import cuttingEdgeCatalogue from "../../../packages/domain/src/cutting-edge-catalogue.generated.json";

/** How many rows of each kind one character's completed evidence holds. */
export type EvidenceVolume = Readonly<{
  kills: number;
  wipes: number;
  tierBests: number;
  cuttingEdges: number;
}>;

export type SyntheticEvidence = Readonly<{
  kills: readonly CharacterMythicKillInput[];
  wipes: readonly CharacterMythicWipeInput[];
  tierBests: readonly CharacterTierBestParseInput[];
  cuttingEdges: readonly CharacterCuttingEdgeInput[];
}>;

/**
 * Proportions taken from completed evidence on `test` on 2026-09-27 (see
 * `docs/research/2026-09-27-issue-666-dossier-db-calls.md`). Aggregates only:
 * about 11 kills per boss killed, about 2.6 kills per report, 81% of kills
 * with all three parses available, 1.3% with a stored world rank.
 */
const killsPerBoss = 11;
const killsPerReport = 3;
const parsedEvery = 5; // one kill in five has no parse
const rankedEvery = 77; // one kill in 77 has a world rank

/**
 * No synthetic kill or wipe is dated after this, so the fixture never holds
 * evidence from the future, whatever day it runs. A raid still open has no
 * window end, and weekly kills from its start would otherwise run past today.
 * If the catalogue gains a raid that opens after this date, the unit test
 * fails; move the cutoff past its start.
 */
export const syntheticEvidenceCutoff = "2026-09-01T00:00:00.000Z";

const spec = {
  name: "Fire",
  iconUrl:
    "https://wow.zamimg.com/images/wow/icons/medium/spell_fire_firebolt.jpg"
} as const;

type Encounter = Readonly<{
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  bossOrder: number;
  /** The raid's position in the catalogue, newest first. */
  raidIndex: number;
  /** A time inside the raid's current-content window, or a fixed fallback. */
  baseMs: number;
  /** The latest time a row may carry: the window's end or the cutoff. */
  latestMs: number;
}>;

/** Every catalogued boss, newest raid first, in boss order. */
function encounters(): readonly Encounter[] {
  return supportedRaidCatalogue().flatMap((raid, raidIndex) => {
    const window = lookupRaidCurrentContentWindow(raid.raidId);
    const baseMs = Date.parse(window?.startsAt ?? "2020-01-07T19:00:00.000Z");
    const cutoffMs = Date.parse(syntheticEvidenceCutoff);
    const endMs = window?.endsAt ? Date.parse(window.endsAt) : cutoffMs;
    const latestMs = Math.max(baseMs, Math.min(endMs, cutoffMs));
    return raid.encounters.map((encounter) => ({
      raidId: raid.raidId,
      raidName: raid.raidName,
      bossId: encounter.bossId,
      bossName: encounter.bossName,
      bossOrder: encounter.bossOrder,
      raidIndex,
      baseMs,
      latestMs
    }));
  });
}

/** A spread of percentiles between 0 and 99.9, varied by index. */
function percentile(index: number): number {
  return ((index * 37) % 1000) / 10;
}

/**
 * Evidence for one character. `label` keeps report codes and guild names
 * distinct between characters; it must be letters only, like a character
 * name.
 */
export function syntheticEvidence(
  label: string,
  volume: EvidenceVolume
): SyntheticEvidence {
  const bosses = encounters();
  const hourMs = 3_600_000;
  const weekMs = 7 * 24 * hourMs;
  // The guild changes every two raids, so a character carries about
  // as many guilds as a real one does (1.7 on average).
  const guildFor = (encounter: Encounter) => ({
    name: `Profile${label}${Math.floor(encounter.raidIndex / 2) % 2 === 0 ? "Main" : "Old"}`,
    realm: "silvermoon"
  });
  const at = (encounter: Encounter, offsetMs: number) =>
    new Date(
      Math.min(encounter.baseMs + offsetMs, encounter.latestMs)
    ).toISOString();
  const report = (index: number) =>
    `https://www.warcraftlogs.com/reports/profile${label}${index}`;

  const kills = Array.from({ length: volume.kills }, (_, index) => {
    const encounter = bosses[Math.floor(index / killsPerBoss) % bosses.length]!;
    const reportUrl = report(Math.floor(index / killsPerReport));
    const available = index % parsedEvery !== parsedEvery - 1;
    const metric = (offset: number) =>
      available
        ? {
            state: "available" as const,
            percentile: percentile(index + offset)
          }
        : { state: "unavailable" as const };
    return {
      raidId: encounter.raidId,
      raidName: encounter.raidName,
      bossId: encounter.bossId,
      bossName: encounter.bossName,
      journalBossId: encounter.bossId,
      bossOrder: encounter.bossOrder,
      killedAt: at(encounter, (index % killsPerBoss) * weekMs),
      reportUrl,
      fightUrl: `${reportUrl}#fight=${index + 1}`,
      guild: { ...guildFor(encounter), region: "eu" as const },
      uploader: `Profile${label}Uploader`,
      historicWorldRank: index % rankedEvery === 0 ? 1000 + index : null,
      // Every kill has been asked about already, so a warm read makes no
      // Raider.IO rankings lookup, as a warm production read makes none.
      historicRankCheckedAt: new Date(encounter.baseMs).toISOString(),
      performance: {
        spec,
        damage: metric(0),
        healing: metric(11),
        bossDamage: metric(23)
      }
    };
  });

  // Wipes land on the bosses the kills do, as progression does.
  const killedBosses = Math.max(1, Math.ceil(volume.kills / killsPerBoss));
  const wipesPerBoss = Math.max(1, Math.ceil(volume.wipes / killedBosses));
  const wipes = Array.from({ length: volume.wipes }, (_, index) => {
    const encounter = bosses[Math.floor(index / wipesPerBoss) % bosses.length]!;
    const reportUrl = report(100_000 + Math.floor(index / 10));
    return {
      raidId: encounter.raidId,
      raidName: encounter.raidName,
      bossId: encounter.bossId,
      bossName: encounter.bossName,
      journalBossId: encounter.bossId,
      bossOrder: encounter.bossOrder,
      attemptedAt: at(encounter, (index % wipesPerBoss) * hourMs),
      reportUrl,
      fightUrl: `${reportUrl}#fight=${index + 1}`,
      guild: guildFor(encounter),
      uploader: `Profile${label}Uploader`
    };
  });

  const tierBests = bosses
    .slice(0, volume.tierBests)
    .map((encounter, index) => ({
      raidId: encounter.raidId,
      raidName: encounter.raidName,
      bossId: encounter.bossId,
      bossName: encounter.bossName,
      rankingsUrl: `https://www.warcraftlogs.com/character/eu/silvermoon/profile${label}?zone=${encounter.raidId}&boss=${encounter.bossId}`,
      performance: {
        spec,
        damage: { state: "available" as const, percentile: percentile(index) },
        healing: { state: "not_applicable" as const },
        bossDamage: { state: "unavailable" as const }
      }
    }));

  // The catalogue runs oldest first, so its tail is the newest tiers.
  const { achievements } = cuttingEdgeCatalogue;
  const cuttingEdges = achievements
    .slice(Math.max(0, achievements.length - volume.cuttingEdges))
    .map((achievement, index) => ({
      achievementId: achievement.achievementId,
      completedAt: new Date(
        Date.parse("2012-10-02T19:00:00.000Z") + index * 16 * weekMs
      ).toISOString()
    }));

  return { kills, wipes, tierBests, cuttingEdges };
}
