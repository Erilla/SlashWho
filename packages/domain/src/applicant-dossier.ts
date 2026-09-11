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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function killKey(kill: DossierKillEvidence): string {
  return [canonicalCharacterId(kill.character), kill.raidId, kill.bossId].join(
    "\u0000"
  );
}

function evidenceKey(kill: DossierKillEvidence): string {
  return [
    kill.raidId,
    kill.bossId,
    kill.reportUrl ?? kill.killedAt,
    kill.reportUrl === null ? kill.killedAt : ""
  ].join("\u0000");
}

function compareKillEvidence(
  left: DossierKillEvidence,
  right: DossierKillEvidence
): number {
  return (
    compareText(left.killedAt, right.killedAt) ||
    compareText(left.reportUrl ?? "", right.reportUrl ?? "") ||
    compareText(
      canonicalCharacterId(left.character),
      canonicalCharacterId(right.character)
    )
  );
}

export function buildApplicantDossier(
  input: BuildApplicantDossierInput
): ApplicantDossier {
  const earliestByCharacterBoss = new Map<string, DossierKillEvidence>();

  for (const kill of input.kills) {
    const key = killKey(kill);
    const existing = earliestByCharacterBoss.get(key);
    if (!existing || compareKillEvidence(kill, existing) < 0) {
      earliestByCharacterBoss.set(key, kill);
    }
  }

  const byBoss = new Map<string, DossierKillEvidence[]>();
  for (const kill of earliestByCharacterBoss.values()) {
    const key = [kill.raidId, kill.bossId].join("\u0000");
    const values = byBoss.get(key) ?? [];
    values.push(kill);
    byBoss.set(key, values);
  }

  const raids = new Map<
    string,
    { raidName: string; bosses: ApplicantDossierBoss[]; hasFinalBoss: boolean }
  >();
  for (const kills of byBoss.values()) {
    const firstEvidence = [...kills].sort(compareKillEvidence)[0];
    const sharedEvidence = kills.filter(
      (kill) => evidenceKey(kill) === evidenceKey(firstEvidence)
    );
    const creditedCharacters = new Set(
      sharedEvidence.map((kill) => canonicalCharacterId(kill.character))
    );
    const characters = input.characters
      .filter((character) =>
        creditedCharacters.has(canonicalCharacterId(character.key))
      )
      .map((character) => character.displayName);
    const raid = raids.get(firstEvidence.raidId) ?? {
      raidName: firstEvidence.raidName,
      bosses: [],
      hasFinalBoss: false
    };
    raid.bosses.push({
      bossId: firstEvidence.bossId,
      bossName: firstEvidence.bossName,
      bossOrder: firstEvidence.bossOrder,
      firstKill: {
        killedAt: firstEvidence.killedAt,
        guild: firstEvidence.guild,
        historicWorldRank: firstEvidence.historicWorldRank,
        reportUrl: firstEvidence.reportUrl,
        characters
      }
    });
    raid.hasFinalBoss ||= firstEvidence.isFinalBoss;
    raids.set(firstEvidence.raidId, raid);
  }

  return {
    root: input.root,
    characters: input.characters,
    raids: [...raids.entries()]
      .map(([raidId, raid]) => ({
        raidId,
        raidName: raid.raidName,
        cuttingEdge: raid.hasFinalBoss ? (true as const) : null,
        bosses: raid.bosses.sort(
          (left, right) =>
            left.bossOrder - right.bossOrder ||
            compareText(left.bossName, right.bossName) ||
            compareText(left.bossId, right.bossId)
        )
      }))
      .sort(
        (left, right) =>
          compareText(left.raidName, right.raidName) ||
          compareText(left.raidId, right.raidId)
      ),
    limitations: input.limitations
  };
}
