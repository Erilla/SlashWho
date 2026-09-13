import {
  applicantDossierSchema,
  type ApplicantDossier as ContractApplicantDossier,
  type DossierLimitation as ContractDossierLimitation
} from "@slashwho/contracts";
import type {
  DiscoveryQueue,
  Repositories,
  StoredCharacterMythicKill,
  StoredSnapshotCharacter
} from "@slashwho/database";
import {
  buildApplicantDossier,
  lookupRaiderIoBoss,
  parseApplicantCharacterUrl,
  toRaiderIoUrl,
  type CharacterKey,
  type DossierCuttingEdgeEvidence,
  type DossierKillEvidence,
  type DossierLimitation
} from "@slashwho/domain";
import type { BlizzardGateway } from "@slashwho/blizzard";
import type { MythicBossRanking, RaiderIoGateway } from "@slashwho/raiderio";

import type { ApplicationConfig } from "./config";
import type {
  CreateSearchCommand,
  CreateSearchResult,
  SearchService
} from "./search-service";

export type CreateDossierCommand = CreateSearchCommand;
export type CreateDossierResult = CreateSearchResult;
export type ReadDossierResult =
  { kind: "ready"; dossier: ContractApplicantDossier } | { kind: "not_ready" };

export interface ApplicantDossierService {
  start(input: CreateDossierCommand): Promise<CreateDossierResult>;
  readInitial(
    key: CharacterKey,
    signal?: AbortSignal
  ): Promise<ReadDossierResult>;
  read(key: CharacterKey, signal?: AbortSignal): Promise<ReadDossierResult>;
}

type EvidenceSource = "raiderio" | "warcraft_logs" | "blizzard";
type DossierSubject = Readonly<{
  key: CharacterKey;
  displayName: string;
  className: string | null;
  raiderIoUrl: string;
  source: StoredSnapshotCharacter["source"] | "submitted";
}>;
type EvidenceResult = Readonly<{
  kills: readonly DossierKillEvidence[];
  cuttingEdges: readonly DossierCuttingEdgeEvidence[];
  limitations: readonly DossierLimitation[];
}>;

function contractLimitationCode(
  code: string
): ContractDossierLimitation["code"] {
  return code === "schema_drift"
    ? "schema_changed"
    : (code as ContractDossierLimitation["code"]);
}

function limitationMessage(
  source: EvidenceSource,
  code: ContractDossierLimitation["code"]
): string {
  const label =
    source === "raiderio"
      ? "Raider.IO"
      : source === "blizzard"
        ? "Blizzard achievement data"
        : "Warcraft Logs";
  switch (code) {
    case "not_found":
      return `${label} has no public evidence for this character.`;
    case "private":
      return `${label} evidence for this character is private.`;
    case "rate_limited":
      return `${label} is temporarily rate limited.`;
    case "request_cap":
      return `${label} history is incomplete because this dossier reached its request cap. Shown kills are the earliest found so far; older kills may exist.`;
    case "unavailable":
      if (source === "blizzard")
        return `${label} could not be read; Cutting Edge status is unknown for this character.`;
      return `${label} history could not be fully loaded. Shown kills are the earliest found so far; older kills may exist.`;
    case "schema_changed":
      return `${label} returned an unexpected response, so history is incomplete. Shown kills are the earliest found so far; older kills may exist.`;
  }
}

function limitation(
  source: EvidenceSource,
  character: CharacterKey,
  code: string
): DossierLimitation {
  return { source, character, code: contractLimitationCode(code) };
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

function cachedKill(
  kill: StoredCharacterMythicKill,
  character: CharacterKey
): DossierKillEvidence {
  return {
    raidId: kill.raidId,
    raidName: kill.raidName,
    bossId: kill.bossId,
    bossName: kill.bossName,
    journalBossId: kill.journalBossId,
    bossOrder: kill.bossOrder,
    isFinalBoss: kill.isFinalBoss,
    character,
    killedAt: kill.killedAt,
    guild: kill.guild,
    historicWorldRank: kill.historicWorldRank ?? null,
    reportUrl: kill.fightUrl
  };
}

async function gatherCharacterEvidence(
  character: DossierSubject,
  options: {
    repositories: Pick<Repositories, "evidence">;
    queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
    blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
    freshnessCutoff: Date;
    signal?: AbortSignal;
  }
): Promise<EvidenceResult & { gathering: boolean }> {
  const reservation = await options.repositories.evidence.reserve({
    key: character.key,
    freshnessCutoff: options.freshnessCutoff,
    at: new Date()
  });
  if (reservation.kind === "reserved") {
    const queueJobId = await options.queue.enqueueCharacterEvidence(
      reservation.run.id
    );
    await options.repositories.evidence.markEnqueued(
      reservation.run.id,
      queueJobId
    );
  }
  const blizzard = await options.blizzard
    .getCompletedAchievements(character.key, options.signal)
    .catch((error: unknown) => {
      if (isAbort(error, options.signal)) throw error;
      return null;
    });
  const limitations: DossierLimitation[] = [];
  const completed = reservation.completed;
  if (completed?.run.limitationCode) {
    limitations.push(
      limitation("warcraft_logs", character.key, completed.run.limitationCode)
    );
  }
  if (blizzard === null) {
    limitations.push(limitation("blizzard", character.key, "unavailable"));
  }
  return {
    limitations,
    kills:
      completed?.kills.map((kill) => cachedKill(kill, character.key)) ?? [],
    cuttingEdges:
      blizzard?.map((achievement) => ({
        ...achievement,
        character: character.key
      })) ?? [],
    gathering: reservation.kind !== "fresh"
  };
}

function serializeDossierSubject(character: DossierSubject) {
  return {
    key: character.key,
    displayName: character.displayName,
    className: character.className,
    raiderIoUrl: character.raiderIoUrl,
    source:
      character.source === "submitted"
        ? ("submitted" as const)
        : character.source === "fingerprint"
          ? ("fingerprint_derived" as const)
          : ("raiderio_declared" as const)
  };
}

function normalizedIdentity(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleLowerCase("en-US");
}

function normalizedRealm(value: string): string {
  return normalizedIdentity(value).replace(/^connected/, "");
}

function historicRank(
  kill: DossierKillEvidence,
  rankings: readonly MythicBossRanking[]
): number | null {
  if (!kill.guild) return null;
  const killedAt = Date.parse(kill.killedAt);
  if (!Number.isFinite(killedAt)) return null;
  const matches = rankings.filter(
    (ranking) =>
      normalizedIdentity(ranking.guildName) ===
        normalizedIdentity(kill.guild!.name) &&
      normalizedRealm(ranking.guildRealm) ===
        normalizedRealm(kill.guild!.realm) &&
      normalizedIdentity(ranking.guildRegion) ===
        normalizedIdentity(kill.character.region) &&
      Math.abs(Date.parse(ranking.firstDefeated) - killedAt) <= 120_000
  );
  return matches.length === 1 ? matches[0]!.rank : null;
}

async function enrichHistoricRanks(options: {
  kills: readonly DossierKillEvidence[];
  raiderio: Pick<RaiderIoGateway, "getMythicBossRankings">;
  signal: AbortSignal;
}): Promise<readonly DossierKillEvidence[]> {
  const rankings = new Map<string, readonly MythicBossRanking[]>();
  const requests = new Map<
    string,
    Readonly<{ raidSlug: string; bossSlug: string }>
  >();
  for (const kill of options.kills) {
    if (!kill.guild) continue;
    const boss = lookupRaiderIoBoss(kill.raidName, kill.bossName);
    if (boss) requests.set(`${boss.raidSlug}\0${boss.bossSlug}`, boss);
  }
  await Promise.all(
    [...requests.entries()].map(async ([key, boss]) => {
      const result = await options.raiderio.getMythicBossRankings(
        boss,
        options.signal
      );
      if (result.kind === "rankings") rankings.set(key, result.rows);
    })
  );
  return options.kills.map((kill) => {
    const boss = lookupRaiderIoBoss(kill.raidName, kill.bossName);
    if (!boss) return kill;
    const rows = rankings.get(`${boss.raidSlug}\0${boss.bossSlug}`);
    return rows
      ? { ...kill, historicWorldRank: historicRank(kill, rows) }
      : kill;
  });
}

async function assembleDossier(options: {
  root: CharacterKey;
  subjects: readonly DossierSubject[];
  skippedSubjects: readonly DossierSubject[];
  research: ContractApplicantDossier["research"];
  repositories: Pick<Repositories, "evidence">;
  queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
  blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
  raiderio: Pick<RaiderIoGateway, "getMythicBossRankings">;
  freshnessCutoff: Date;
  signal: AbortSignal;
}): Promise<ContractApplicantDossier> {
  const evidence = await Promise.all(
    options.subjects.map((character) =>
      gatherCharacterEvidence(character, {
        repositories: options.repositories,
        queue: options.queue,
        blizzard: options.blizzard,
        freshnessCutoff: options.freshnessCutoff,
        signal: options.signal
      })
    )
  );
  const limitations = [
    ...evidence.flatMap((item) => item.limitations),
    ...options.skippedSubjects.map((character) =>
      limitation("warcraft_logs", character.key, "request_cap")
    )
  ];
  const dossier = buildApplicantDossier({
    root: options.root,
    characters: options.subjects.map(
      ({ key, displayName, className, raiderIoUrl }) => ({
        key,
        displayName,
        className,
        raiderIoUrl
      })
    ),
    kills: await enrichHistoricRanks({
      kills: evidence.flatMap((item) => item.kills),
      raiderio: options.raiderio,
      signal: options.signal
    }),
    cuttingEdges: evidence.flatMap((item) => item.cuttingEdges),
    limitations
  });
  return applicantDossierSchema.parse({
    ...dossier,
    research: evidence.some((item) => item.gathering)
      ? {
          state: "gathering" as const,
          message:
            "Historic mythic evidence is still gathering in the background. Cached results are shown while it completes."
        }
      : options.research,
    characters: options.subjects.map(serializeDossierSubject),
    limitations: dossier.limitations.map((item) => ({
      ...item,
      code: contractLimitationCode(item.code),
      message: limitationMessage(item.source, contractLimitationCode(item.code))
    }))
  });
}

export function createApplicantDossierService(options: {
  repositories: Pick<Repositories, "snapshots" | "evidence">;
  queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
  search: Pick<SearchService, "create">;
  blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
  raiderio: Pick<RaiderIoGateway, "getMythicBossRankings">;
  config: ApplicationConfig;
}): ApplicantDossierService {
  return {
    async start(input) {
      try {
        return options.search.create({
          ...input,
          characterUrl: toRaiderIoUrl(
            parseApplicantCharacterUrl(input.characterUrl)
          )
        });
      } catch {
        return { kind: "invalid", code: "invalid_character_url" };
      }
    },

    async readInitial(key, signal) {
      return {
        kind: "ready",
        dossier: await assembleDossier({
          root: key,
          subjects: [
            {
              key,
              displayName: key.name,
              className: null,
              raiderIoUrl: toRaiderIoUrl(key),
              source: "submitted"
            }
          ],
          skippedSubjects: [],
          research: {
            state: "initial",
            message:
              "Linked-character research is still running; this evidence covers only the submitted character."
          },
          repositories: options.repositories,
          queue: options.queue,
          blizzard: options.blizzard,
          raiderio: options.raiderio,
          freshnessCutoff: new Date(
            Date.now() - options.config.FRESHNESS_HOURS * 60 * 60 * 1000
          ),
          signal: signal ?? new AbortController().signal
        })
      };
    },

    async read(key, signal) {
      const snapshot = await options.repositories.snapshots.getCurrent(key);
      if (!snapshot) return { kind: "not_ready" };

      const selected = snapshot.characters.slice(
        0,
        options.config.DOSSIER_CHARACTER_CAP
      );
      const skipped = snapshot.characters.slice(selected.length);
      return {
        kind: "ready",
        dossier: await assembleDossier({
          root: snapshot.rootKey,
          subjects: selected,
          skippedSubjects: skipped,
          research:
            snapshot.state === "complete"
              ? {
                  state: "complete",
                  message: "Linked-character research is complete."
                }
              : {
                  state: "partial",
                  message:
                    "Additional linked characters may exist; this dossier is not exhaustive."
                },
          repositories: options.repositories,
          queue: options.queue,
          blizzard: options.blizzard,
          raiderio: options.raiderio,
          freshnessCutoff: new Date(
            Date.now() - options.config.FRESHNESS_HOURS * 60 * 60 * 1000
          ),
          signal: signal ?? new AbortController().signal
        })
      };
    }
  };
}
