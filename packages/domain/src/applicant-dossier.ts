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
  reportUrls: readonly string[];
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
  // Preserve the narrow legacy identity only when a malformed timestamp cannot
  // supply the UTC date required by the normal grouping rule.
  return k.reportUrl === null
    ? `character\0${canonicalCharacterId(k.character)}\0${k.killedAt}`
    : `report\0${k.reportUrl}`;
}

function killEventKey(kill: DossierKillEvidence): string {
  const timestamp = Date.parse(kill.killedAt);
  if (!Number.isFinite(timestamp))
    return [kill.character.region, sharedEvidenceKey(kill)].join("\0");
  // The dossier deliberately treats same-region, same-date evidence as one
  // simplified event. Distinct same-day reclears may therefore be merged.
  const utcDate = new Date(timestamp).toISOString().slice(0, 10);
  return [kill.character.region, utcDate].join("\0");
}

function compareAttributedGuild(
  a: NonNullable<DossierKillEvidence["guild"]>,
  b: NonNullable<DossierKillEvidence["guild"]>
): number {
  return (
    text(normalizedGuildText(a.name), normalizedGuildText(b.name)) ||
    text(normalizedGuildText(a.realm), normalizedGuildText(b.realm)) ||
    text(a.name, b.name) ||
    text(a.realm, b.realm)
  );
}

function normalizedGuildText(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function sameAttributedGuild(
  a: NonNullable<DossierKillEvidence["guild"]>,
  b: NonNullable<DossierKillEvidence["guild"]>
): boolean {
  return (
    normalizedGuildText(a.name) === normalizedGuildText(b.name) &&
    normalizedGuildText(a.realm) === normalizedGuildText(b.realm)
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
    const raid = lookupRaidByName(suppliedKill.raidName);
    const journalEncounter =
      suppliedKill.journalBossId === null
        ? null
        : lookupJournalEncounter(suppliedKill.journalBossId);
    const namedEncounter = lookupRaidBossByName(
      suppliedKill.raidName,
      suppliedKill.bossName
    );
    const metadata = raid
      ? (namedEncounter ??
        (journalEncounter?.raidId === raid.raidId ? journalEncounter : null))
      : (journalEncounter ?? lookupUniqueRaidBossByName(suppliedKill.bossName));
    if (metadata === null) continue;
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
    const groupedEvidence = new Map<string, DossierKillEvidence[]>();
    for (const kill of [...kills].sort(compareEvidence)) {
      const key = killEventKey(kill);
      groupedEvidence.set(key, [...(groupedEvidence.get(key) ?? []), kill]);
    }
    const firstKills = [...groupedEvidence.values()]
      .map((shared) => {
        const selected = [...shared].sort(compareEvidence)[0]!;
        const attributed = shared
          .flatMap((k) => (k.guild === null ? [] : [k.guild]))
          .sort(compareAttributedGuild)[0];
        const ranks = new Set(
          shared.flatMap((k) =>
            attributed !== undefined &&
            k.guild !== null &&
            sameAttributedGuild(k.guild, attributed) &&
            k.historicWorldRank !== null
              ? [k.historicWorldRank]
              : []
          )
        );
        const reportUrls = [
          ...new Set(shared.flatMap((k) => (k.reportUrl ? [k.reportUrl] : [])))
        ].sort(text);
        const ids = new Set(
          shared.map((kill) => canonicalCharacterId(kill.character))
        );
        return {
          selected,
          firstKill: {
            killedAt: selected.killedAt,
            guild: attributed ?? null,
            historicWorldRank: ranks.size === 1 ? [...ranks][0]! : null,
            reportUrl: selected.reportUrl,
            reportUrls,
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
