import { canonicalCharacterId } from "./deduplicate";
import type { CharacterKey } from "./character-key";
import {
  lookupJournalEncounter,
  lookupRaidBossByName,
  lookupRaidByName,
  lookupUniqueRaidBossByName
} from "./raid-catalogue";
import { lookupCuttingEdgeAchievement } from "./cutting-edge-catalogue";

export type DossierCharacter = Readonly<{
  key: CharacterKey;
  displayName: string;
  className?: string | null;
  raiderIoUrl?: string;
}>;
export type DossierKillEvidence = Readonly<{
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  journalBossId: string | null;
  bossOrder: number;
  isFinalBoss: boolean;
  character: CharacterKey;
  killedAt: string;
  guild: Readonly<{ name: string; realm: string }> | null;
  historicWorldRank: number | null;
  reportUrl: string | null;
}>;
export type DossierLimitation = Readonly<{
  source: "raiderio" | "warcraft_logs" | "blizzard";
  character: CharacterKey | null;
  code: string;
}>;
export type DossierCuttingEdgeEvidence = Readonly<{
  achievementId: string;
  completedAt: string;
  character: CharacterKey;
}>;
export type BuildApplicantDossierInput = Readonly<{
  root: CharacterKey;
  characters: readonly DossierCharacter[];
  kills: readonly DossierKillEvidence[];
  cuttingEdges?: readonly DossierCuttingEdgeEvidence[];
  limitations: readonly DossierLimitation[];
}>;
export type ApplicantDossierFirstKill = Readonly<{
  killedAt: string;
  guild: Readonly<{ name: string; realm: string }> | null;
  historicWorldRank: number | null;
  reportUrl: string | null;
  characters: readonly string[];
}>;
export type ApplicantDossierBoss = Readonly<{
  bossId: string;
  bossName: string;
  bossOrder: number;
  imageUrl: string | null;
  firstKill: ApplicantDossierFirstKill;
  firstKills: readonly ApplicantDossierFirstKill[];
}>;
export type ApplicantDossierRaid = Readonly<{
  raidId: string;
  raidName: string;
  imageUrl: string | null;
  cuttingEdge: true | null;
  bosses: readonly ApplicantDossierBoss[];
}>;
type AggregatedDossierBoss = ApplicantDossierBoss &
  Readonly<{ isFinalBoss: boolean }>;
export type ApplicantDossierCuttingEdge = Readonly<{
  achievementId: string;
  achievementName: string;
  description: string;
  iconUrl: string | null;
  completedAt: string;
  characters: readonly string[];
}>;
export type ApplicantDossier = Readonly<{
  root: CharacterKey;
  characters: readonly DossierCharacter[];
  raids: readonly ApplicantDossierRaid[];
  cuttingEdges: readonly ApplicantDossierCuttingEdge[];
  limitations: readonly DossierLimitation[];
}>;

function text(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function optionalText(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  return text(a, b);
}
function optionalNumber(a: number | null, b: number | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  return a - b;
}
function compareGuild(
  a: DossierKillEvidence["guild"],
  b: DossierKillEvidence["guild"]
): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  return text(a.name, b.name) || text(a.realm, b.realm);
}
function compareEvidence(
  a: DossierKillEvidence,
  b: DossierKillEvidence
): number {
  // Every normalized field participates so equal timestamps never depend on input order.
  return (
    text(a.killedAt, b.killedAt) ||
    text(a.raidName, b.raidName) ||
    text(a.bossName, b.bossName) ||
    a.bossOrder - b.bossOrder ||
    optionalText(a.reportUrl, b.reportUrl) ||
    compareGuild(a.guild, b.guild) ||
    optionalNumber(a.historicWorldRank, b.historicWorldRank) ||
    (a.isFinalBoss === b.isFinalBoss ? 0 : a.isFinalBoss ? -1 : 1) ||
    text(canonicalCharacterId(a.character), canonicalCharacterId(b.character))
  );
}
function sharedEvidenceKey(k: DossierKillEvidence): string {
  // A participant can only share evidence when the source identifies the same
  // fight. Timestamp-only evidence cannot prove that two character kills were
  // the same event, so it remains distinct per character.
  return k.reportUrl === null
    ? `character\0${canonicalCharacterId(k.character)}\0${k.killedAt}`
    : `report\0${k.reportUrl}`;
}

function sameGuildKill(
  a: DossierKillEvidence,
  b: DossierKillEvidence
): boolean {
  if (
    a.guild === null ||
    b.guild === null ||
    a.reportUrl === null ||
    b.reportUrl === null
  )
    return false;
  const aTime = Date.parse(a.killedAt);
  const bTime = Date.parse(b.killedAt);
  return (
    Number.isFinite(aTime) &&
    Number.isFinite(bTime) &&
    a.guild.name.trim().toLocaleLowerCase("en-US") ===
      b.guild.name.trim().toLocaleLowerCase("en-US") &&
    a.guild.realm.trim().toLocaleLowerCase("en-US") ===
      b.guild.realm.trim().toLocaleLowerCase("en-US") &&
    Math.abs(aTime - bTime) <= 120_000
  );
}

function isNonRaidWclZone(zoneName: string): boolean {
  return /^(?:mythic\+\s+seasons?|(?:normal|heroic|mythic)\s+dungeons)\b/i.test(
    zoneName.trim()
  );
}

export function buildApplicantDossier(
  input: BuildApplicantDossierInput
): ApplicantDossier {
  const cuttingEdges = new Map<
    string,
    {
      achievement: NonNullable<ReturnType<typeof lookupCuttingEdgeAchievement>>;
      characters: Set<string>;
      completedAt: string;
    }
  >();
  for (const evidence of input.cuttingEdges ?? []) {
    const achievement = lookupCuttingEdgeAchievement(evidence.achievementId);
    if (!achievement) continue;
    const character = input.characters.find(
      (item) =>
        canonicalCharacterId(item.key) ===
        canonicalCharacterId(evidence.character)
    );
    if (!character) continue;
    const key = achievement.achievementId;
    const entry = cuttingEdges.get(key) ?? {
      achievement,
      characters: new Set<string>(),
      completedAt: evidence.completedAt
    };
    if (evidence.completedAt < entry.completedAt)
      entry.completedAt = evidence.completedAt;
    entry.characters.add(canonicalCharacterId(character.key));
    cuttingEdges.set(key, entry);
  }
  const allKills: DossierKillEvidence[] = [];
  for (const suppliedKill of input.kills) {
    if (isNonRaidWclZone(suppliedKill.raidName)) continue;
    const metadata =
      (suppliedKill.journalBossId === null
        ? null
        : lookupJournalEncounter(suppliedKill.journalBossId)) ??
      lookupRaidBossByName(suppliedKill.raidName, suppliedKill.bossName) ??
      lookupUniqueRaidBossByName(suppliedKill.bossName);
    const raid = lookupRaidByName(suppliedKill.raidName);
    if (metadata === null && raid === null) continue;
    const kill = { ...suppliedKill, ...(raid ?? {}), ...(metadata ?? {}) };
    allKills.push(kill);
  }
  const byBoss = new Map<string, DossierKillEvidence[]>();
  for (const kill of allKills) {
    const key = [kill.raidId, kill.bossId].join("\0");
    byBoss.set(key, [...(byBoss.get(key) ?? []), kill]);
  }
  const raids = new Map<
    string,
    {
      raidName: string;
      imageUrl: string | null;
      bosses: AggregatedDossierBoss[];
      tierOrdinal: number | null;
    }
  >();
  for (const kills of byBoss.values()) {
    const groupedEvidence: DossierKillEvidence[][] = [];
    for (const kill of [...kills].sort(compareEvidence)) {
      const group = groupedEvidence.find((candidate) => {
        const selected = candidate[0]!;
        return (
          sharedEvidenceKey(selected) === sharedEvidenceKey(kill) ||
          sameGuildKill(selected, kill)
        );
      });
      if (group) group.push(kill);
      else groupedEvidence.push([kill]);
    }
    const firstKills = groupedEvidence
      .map((shared) => {
        const selected = [...shared].sort(compareEvidence)[0]!;
        const ids = new Set(
          shared.map((kill) => canonicalCharacterId(kill.character))
        );
        return {
          selected,
          firstKill: {
            killedAt: selected.killedAt,
            guild: selected.guild,
            historicWorldRank: selected.historicWorldRank,
            reportUrl: selected.reportUrl,
            characters: input.characters
              .filter((c) => ids.has(canonicalCharacterId(c.key)))
              .map((c) => c.displayName)
          }
        };
      })
      .sort((a, b) => compareEvidence(a.selected, b.selected));
    const selected = firstKills[0]!.selected;
    const raid = raids.get(selected.raidId) ?? {
      raidName: selected.raidName,
      imageUrl: lookupRaidByName(selected.raidName)?.imageUrl ?? null,
      bosses: [],
      tierOrdinal: lookupRaidByName(selected.raidName)?.tierOrdinal ?? null
    };
    raid.bosses.push({
      bossId: selected.bossId,
      bossName: selected.bossName,
      bossOrder: selected.bossOrder,
      imageUrl:
        lookupJournalEncounter(selected.bossId)?.imageUrl ??
        lookupRaidBossByName(selected.raidName, selected.bossName)?.imageUrl ??
        null,
      firstKill: firstKills[0]!.firstKill,
      firstKills: firstKills.map((entry) => entry.firstKill),
      isFinalBoss: selected.isFinalBoss
    });
    raids.set(selected.raidId, raid);
  }
  return {
    root: input.root,
    characters: input.characters,
    cuttingEdges: [...cuttingEdges.entries()]
      .map(([, entry]) => {
        return {
          achievementId: entry.achievement.achievementId,
          achievementName: entry.achievement.achievementName,
          description: entry.achievement.description,
          iconUrl: entry.achievement.iconUrl,
          completedAt: entry.completedAt,
          characters: input.characters
            .filter((character) =>
              entry.characters.has(canonicalCharacterId(character.key))
            )
            .map((character) => character.displayName)
        };
      })
      .sort(
        (a, b) =>
          text(b.completedAt, a.completedAt) ||
          text(a.achievementId, b.achievementId)
      ),
    limitations: input.limitations,
    raids: [...raids.entries()]
      .map(([raidId, raid]) => ({
        raidId,
        raidName: raid.raidName,
        imageUrl: raid.imageUrl,
        cuttingEdge: null,
        bosses: raid.bosses
          .sort(
            (a, b) =>
              Number(b.isFinalBoss) - Number(a.isFinalBoss) ||
              b.bossOrder - a.bossOrder ||
              text(a.bossName, b.bossName) ||
              text(a.bossId, b.bossId)
          )
          .map(({ isFinalBoss, ...boss }) => {
            void isFinalBoss;
            return boss;
          })
      }))
      .sort((a, b) => {
        const tierA = raids.get(a.raidId)?.tierOrdinal ?? null;
        const tierB = raids.get(b.raidId)?.tierOrdinal ?? null;
        if (tierA !== null || tierB !== null) {
          if (tierA === null) return 1;
          if (tierB === null) return -1;
          if (tierA !== tierB) return tierB - tierA;
        }
        return text(a.raidName, b.raidName) || text(a.raidId, b.raidId);
      })
  };
}
