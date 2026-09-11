import { canonicalCharacterId } from "./deduplicate";
import type { CharacterKey } from "./character-key";

export type DossierCharacter = Readonly<{
  key: CharacterKey;
  displayName: string;
}>;
export type DossierKillEvidence = Readonly<{
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  bossOrder: number;
  isFinalBoss: boolean;
  character: CharacterKey;
  killedAt: string;
  guild: Readonly<{ name: string; realm: string }> | null;
  historicWorldRank: number | null;
  reportUrl: string | null;
}>;
export type DossierLimitation = Readonly<{
  source: "raiderio" | "warcraft_logs";
  character: CharacterKey | null;
  code: string;
}>;
export type BuildApplicantDossierInput = Readonly<{
  root: CharacterKey;
  characters: readonly DossierCharacter[];
  kills: readonly DossierKillEvidence[];
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
}>;
export type ApplicantDossierRaid = Readonly<{
  raidId: string;
  raidName: string;
  cuttingEdge: true | null;
  bosses: readonly ApplicantDossierBoss[];
}>;
export type ApplicantDossier = Readonly<{
  root: CharacterKey;
  characters: readonly DossierCharacter[];
  raids: readonly ApplicantDossierRaid[];
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
  return [k.raidId, k.bossId, k.reportUrl ?? k.killedAt].join("\0");
}

export function buildApplicantDossier(
  input: BuildApplicantDossierInput
): ApplicantDossier {
  const earliest = new Map<string, DossierKillEvidence>();
  for (const kill of input.kills) {
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
    const selected = [...kills].sort(compareEvidence)[0];
    const shared = kills.filter(
      (kill) => sharedEvidenceKey(kill) === sharedEvidenceKey(selected)
    );
    const ids = new Set(
      shared.map((kill) => canonicalCharacterId(kill.character))
    );
    const characters = input.characters
      .filter((c) => ids.has(canonicalCharacterId(c.key)))
      .map((c) => c.displayName);
    const raid = raids.get(selected.raidId) ?? {
      raidName: selected.raidName,
      bosses: [],
      final: false
    };
    raid.bosses.push({
      bossId: selected.bossId,
      bossName: selected.bossName,
      bossOrder: selected.bossOrder,
      firstKill: {
        killedAt: selected.killedAt,
        guild: selected.guild,
        historicWorldRank: selected.historicWorldRank,
        reportUrl: selected.reportUrl,
        characters
      }
    });
    raid.final ||= kills.some((kill) => kill.isFinalBoss);
    raids.set(selected.raidId, raid);
  }
  return {
    root: input.root,
    characters: input.characters,
    limitations: input.limitations,
    raids: [...raids.entries()]
      .map(([raidId, raid]) => ({
        raidId,
        raidName: raid.raidName,
        cuttingEdge: raid.final ? (true as const) : null,
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
