import {
  applicantDossierSchema,
  type ApplicantDossier as ContractApplicantDossier,
  type DossierLimitation as ContractDossierLimitation
} from "@slashwho/contracts";
import type { Repositories, StoredSnapshotCharacter } from "@slashwho/database";
import {
  buildApplicantDossier,
  parseApplicantCharacterUrl,
  toRaiderIoUrl,
  type CharacterKey,
  type DossierCuttingEdgeEvidence,
  type DossierKillEvidence,
  type DossierLimitation,
  isAccountWideCuttingEdgeAchievement
} from "@slashwho/domain";
import type { BlizzardGateway } from "@slashwho/blizzard";
import type { WarcraftLogsGateway } from "@slashwho/warcraftlogs";

import type { ApplicationConfig } from "./config";
import { createBoundedCache } from "./bounded-cache";
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
type DossierSubject = Pick<StoredSnapshotCharacter, "key" | "displayName"> & {
  source: StoredSnapshotCharacter["source"] | "submitted";
};
type EvidenceResult = Readonly<{
  kills: readonly DossierKillEvidence[];
  limitations: readonly DossierLimitation[];
}>;
type CuttingEdgeEvidenceResult = Readonly<{
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

function awaitWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

async function gatherCharacterEvidence(
  character: DossierSubject,
  options: {
    warcraftLogs: Pick<WarcraftLogsGateway, "getFirstKillReports">;
    requestCap: number;
    signal?: AbortSignal;
  }
): Promise<EvidenceResult> {
  const warcraftLogs = await options.warcraftLogs
    .getFirstKillReports(character.key, {
      requestCap: options.requestCap,
      signal: options.signal
    })
    .catch((error: unknown) => {
      if (isAbort(error, options.signal)) throw error;
      return { kind: "limitation" as const, code: "unavailable" as const };
    });
  const limitations: DossierLimitation[] = [];
  if (warcraftLogs.kind === "evidence" && warcraftLogs.limitation) {
    limitations.push(
      limitation("warcraft_logs", character.key, warcraftLogs.limitation.code)
    );
  }
  if (warcraftLogs.kind === "limitation") {
    limitations.push(
      limitation("warcraft_logs", character.key, warcraftLogs.code)
    );
  }
  return {
    limitations,
    kills:
      warcraftLogs.kind === "evidence"
        ? warcraftLogs.kills.map((kill) => ({
            raidId: kill.raidId,
            raidName: kill.raidName,
            bossId: kill.bossId,
            bossName: kill.bossName,
            journalBossId: kill.journalBossId,
            bossOrder: kill.bossOrder,
            isFinalBoss: kill.isFinalBoss,
            character: character.key,
            killedAt: kill.killedAt,
            guild: kill.guild,
            historicWorldRank: kill.historicWorldRank,
            reportUrl: kill.fightUrl
          }))
        : []
  };
}

async function gatherCuttingEdgeEvidence(
  subjects: readonly DossierSubject[],
  options: {
    blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
    signal?: AbortSignal;
  }
): Promise<CuttingEdgeEvidenceResult> {
  const cuttingEdges: DossierCuttingEdgeEvidence[] = [];
  const limitations: DossierLimitation[] = [];
  let fingerprintAccountEstablished = false;

  for (const character of subjects) {
    // Fingerprint-derived subjects are established from identical Blizzard
    // achievement timestamps. Once one valid account profile has been read,
    // another such subject cannot alter the allowlisted account-wide result.
    if (character.source === "fingerprint" && fingerprintAccountEstablished) {
      continue;
    }

    let achievements;
    try {
      achievements = await options.blizzard.getCompletedAchievements(
        character.key,
        options.signal
      );
    } catch (error) {
      if (isAbort(error, options.signal)) throw error;
      limitations.push(limitation("blizzard", character.key, "unavailable"));
      continue;
    }

    const supportedAchievements = achievements.filter((achievement) =>
      isAccountWideCuttingEdgeAchievement(achievement.achievementId)
    );
    cuttingEdges.push(...supportedAchievements);
    // A successful root or fingerprint profile establishes account-wide
    // Cutting Edge evidence for the fingerprint-verified account only.
    // Raider.IO-declared characters are not treated as Blizzard-account proof.
    if (character.source !== "claimed" && supportedAchievements.length > 0) {
      fingerprintAccountEstablished = true;
    }
  }

  return { cuttingEdges, limitations };
}

function serializeDossierSubject(character: DossierSubject) {
  return {
    key: character.key,
    displayName: character.displayName,
    source:
      character.source === "submitted"
        ? ("submitted" as const)
        : character.source === "fingerprint"
          ? ("fingerprint_derived" as const)
          : ("raiderio_declared" as const)
  };
}

function combineSignals(signal: AbortSignal | undefined, timeout: AbortSignal) {
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function assembleDossier(options: {
  root: CharacterKey;
  subjects: readonly DossierSubject[];
  skippedSubjects: readonly DossierSubject[];
  research: ContractApplicantDossier["research"];
  warcraftLogs: Pick<WarcraftLogsGateway, "getFirstKillReports">;
  blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
  requestCap: number;
  signal: AbortSignal;
}): Promise<ContractApplicantDossier> {
  const [evidence, cuttingEdgeEvidence] = await Promise.all([
    Promise.all(
      options.subjects.map((character) =>
        options.requestCap === 0
          ? Promise.resolve({
              kills: [],
              limitations: [
                limitation("warcraft_logs", character.key, "request_cap")
              ]
            })
          : gatherCharacterEvidence(character, {
              warcraftLogs: options.warcraftLogs,
              requestCap: options.requestCap,
              signal: options.signal
            })
      )
    ),
    options.requestCap === 0
      ? Promise.resolve({ cuttingEdges: [], limitations: [] })
      : gatherCuttingEdgeEvidence(options.subjects, {
          blizzard: options.blizzard,
          signal: options.signal
        })
  ]);
  const limitations = [
    ...evidence.flatMap((item) => item.limitations),
    ...cuttingEdgeEvidence.limitations,
    ...options.skippedSubjects.map((character) =>
      limitation("warcraft_logs", character.key, "request_cap")
    )
  ];
  const dossier = buildApplicantDossier({
    root: options.root,
    characters: options.subjects.map(({ key, displayName }) => ({
      key,
      displayName
    })),
    kills: evidence.flatMap((item) => item.kills),
    cuttingEdges: cuttingEdgeEvidence.cuttingEdges,
    limitations
  });
  return applicantDossierSchema.parse({
    ...dossier,
    research: options.research,
    characters: options.subjects.map(serializeDossierSubject),
    limitations: dossier.limitations.map((item) => ({
      ...item,
      code: contractLimitationCode(item.code),
      message: limitationMessage(item.source, contractLimitationCode(item.code))
    }))
  });
}

export function createApplicantDossierService(options: {
  repositories: Pick<Repositories, "snapshots">;
  search: Pick<SearchService, "create">;
  warcraftLogs: Pick<WarcraftLogsGateway, "getFirstKillReports">;
  blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
  config: ApplicationConfig;
}): ApplicantDossierService {
  const achievementCache = createBoundedCache<
    readonly { achievementId: string; completedAt: string }[]
  >({
    ttlMs: 15 * 60_000,
    maxEntries: 1_000
  });
  const blizzard: Pick<BlizzardGateway, "getCompletedAchievements"> = {
    async getCompletedAchievements(key, signal) {
      signal?.throwIfAborted();
      const achievements = await awaitWithAbort(
        achievementCache(`${key.region}/${key.realm}/${key.name}`, async () => {
          const response = await options.blizzard.getCompletedAchievements(
            key,
            AbortSignal.timeout(15_000)
          );
          return response.filter((achievement) =>
            isAccountWideCuttingEdgeAchievement(achievement.achievementId)
          );
        }),
        signal
      );
      signal?.throwIfAborted();
      return achievements;
    }
  };
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
      const timeout = AbortSignal.timeout(
        options.config.DOSSIER_INITIAL_WARCRAFT_LOGS_TIMEOUT_MS
      );
      return {
        kind: "ready",
        dossier: await assembleDossier({
          root: key,
          subjects: [{ key, displayName: key.name, source: "submitted" }],
          skippedSubjects: [],
          research: {
            state: "initial",
            message:
              "Linked-character research is still running; this evidence covers only the submitted character."
          },
          warcraftLogs: options.warcraftLogs,
          blizzard,
          requestCap: options.config.DOSSIER_INITIAL_WARCRAFT_LOGS_REQUEST_CAP,
          signal: combineSignals(signal, timeout)
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
      const timeout = AbortSignal.timeout(
        options.config.DOSSIER_WARCRAFT_LOGS_TIMEOUT_MS
      );
      const requestSignal = combineSignals(signal, timeout);
      // Split one dossier-wide cap across every selected character. The bound
      // is shared (rather than per character) and the timeout covers the whole
      // request, so a large alt list cannot multiply WCL traffic or hang a read.
      const requestCap = Math.floor(
        options.config.DOSSIER_WARCRAFT_LOGS_REQUEST_CAP / selected.length
      );
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
          warcraftLogs: options.warcraftLogs,
          blizzard,
          requestCap,
          signal: requestSignal
        })
      };
    }
  };
}
