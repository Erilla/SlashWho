import { canonicalCharacterId } from "./deduplicate";
import type { CharacterKey } from "./character-key";
import {
  lookupJournalEncounter,
  lookupRaidBossByName,
  lookupRaidByName
} from "./raid-catalogue";
import { lookupCuttingEdgeAchievement } from "./cutting-edge-catalogue";

export type DossierCharacter = Readonly<{
  key: CharacterKey;
  displayName: string;
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
  firstKill: ApplicantDossierFirstKill;
  firstKills: readonly ApplicantDossierFirstKill[];
}>;
export type ApplicantDossierRaid = Readonly<{
  raidId: string;
  raidName: string;
  cuttingEdge: true | null;
  bosses: readonly ApplicantDossierBoss[];
}>;
export type ApplicantDossierCuttingEdge = Readonly<{
  achievementId: string;
  achievementName: string;
  description: string;
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
function characterBossKey(k: DossierKillEvidence): string {
  return [canonicalCharacterId(k.character), k.raidId, k.bossId].join("\0");
}
function sharedEvidenceKey(k: DossierKillEvidence): string {
  // A participant can only share evidence when the source identifies the same
  // fight. Timestamp-only evidence cannot prove that two character kills were
  // the same event, so it remains distinct per character.
  return k.reportUrl === null
    ? `character\0${canonicalCharacterId(k.character)}`
    : `report\0${k.reportUrl}`;
}

export function buildApplicantDossier(
  input: BuildApplicantDossierInput
): ApplicantDossier {
  const cuttingEdges = new Map<
    string,
    {
      achievement: NonNullable<ReturnType<typeof lookupCuttingEdgeAchievement>>;
      characters: Set<string>;
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
    const key = `${achievement.achievementId}\0${evidence.completedAt}`;
    const entry = cuttingEdges.get(key) ?? {
      achievement,
      characters: new Set<string>()
    };
    entry.characters.add(character.displayName);
    cuttingEdges.set(key, entry);
  }
  const earliest = new Map<string, DossierKillEvidence>();
  for (const suppliedKill of input.kills) {
    const metadata =
      (suppliedKill.journalBossId === null
        ? null
        : lookupJournalEncounter(suppliedKill.journalBossId)) ??
      lookupRaidBossByName(suppliedKill.raidName, suppliedKill.bossName);
    const raid = lookupRaidByName(suppliedKill.raidName);
    const kill = { ...suppliedKill, ...(raid ?? {}), ...(metadata ?? {}) };
    const key = characterBossKey(kill);
    const current = earliest.get(key);
    if (!current || compareEvidence(kill, current) < 0) earliest.set(key, kill);
  }
  const byBoss = new Map<string, DossierKillEvidence[]>();
  for (const kill of earliest.values()) {
    const key = [kill.raidId, kill.bossId].join("\0");
    byBoss.set(key, [...(byBoss.get(key) ?? []), kill]);
  }
  const raids = new Map<
    string,
    { raidName: string; bosses: ApplicantDossierBoss[]; final: boolean }
  >();
  for (const kills of byBoss.values()) {
    const byEvidence = new Map<string, DossierKillEvidence[]>();
    for (const kill of kills) {
      const key = sharedEvidenceKey(kill);
      byEvidence.set(key, [...(byEvidence.get(key) ?? []), kill]);
    }
    const firstKills = [...byEvidence.values()]
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
      bosses: [],
      final: false
    };
    raid.bosses.push({
      bossId: selected.bossId,
      bossName: selected.bossName,
      bossOrder: selected.bossOrder,
      firstKill: firstKills[0]!.firstKill,
      firstKills: firstKills.map((entry) => entry.firstKill)
    });
    raid.final ||= kills.some((kill) => kill.isFinalBoss);
    raids.set(selected.raidId, raid);
  }
  return {
    root: input.root,
    characters: input.characters,
    cuttingEdges: [...cuttingEdges.entries()]
      .map(([key, entry]) => {
        const [, completedAt] = key.split("\0", 2);
        return {
          achievementId: entry.achievement.achievementId,
          achievementName: entry.achievement.achievementName,
          description: entry.achievement.description,
          completedAt: completedAt!,
          characters: [...entry.characters].sort(text)
        };
      })
      .sort(
        (a, b) =>
          text(a.completedAt, b.completedAt) ||
          text(a.achievementId, b.achievementId)
      ),
    limitations: input.limitations,
    raids: [...raids.entries()]
      .map(([raidId, raid]) => ({
        raidId,
        raidName: raid.raidName,
        cuttingEdge: null,
        bosses: raid.bosses.sort(
          (a, b) =>
            a.bossOrder - b.bossOrder ||
            text(a.bossName, b.bossName) ||
            text(a.bossId, b.bossId)
        )
      }))
      .sort((a, b) => text(a.raidName, b.raidName) || text(a.raidId, b.raidId))
  };
}
