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
  type DossierKillEvidence,
  type DossierLimitation
} from "@slashwho/domain";
import type { WarcraftLogsGateway } from "@slashwho/warcraftlogs";

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

type EvidenceSource = "raiderio" | "warcraft_logs";
type DossierSubject = Pick<
  StoredSnapshotCharacter,
  "key" | "displayName" | "source"
>;
type EvidenceResult = Readonly<{
  kills: readonly DossierKillEvidence[];
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
  const label = source === "raiderio" ? "Raider.IO" : "Warcraft Logs";
  switch (code) {
    case "not_found":
      return `${label} has no public evidence for this character.`;
    case "private":
      return `${label} evidence for this character is private.`;
    case "rate_limited":
      return `${label} is temporarily rate limited.`;
    case "request_cap":
      return `${label} evidence was skipped because this dossier reached its request cap.`;
    case "unavailable":
      return `${label} evidence is incomplete because the source is temporarily unavailable.`;
    case "schema_changed":
      return `${label} returned an unexpected response.`;
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

function serializeDossierSubject(character: DossierSubject) {
  return {
    key: character.key,
    displayName: character.displayName,
    source:
      character.source === "fingerprint"
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
  requestCap: number;
  signal: AbortSignal;
}): Promise<ContractApplicantDossier> {
  const evidence = await Promise.all(
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
  );
  const limitations = [
    ...evidence.flatMap((item) => item.limitations),
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
      const timeout = AbortSignal.timeout(
        options.config.DOSSIER_INITIAL_WARCRAFT_LOGS_TIMEOUT_MS
      );
      return {
        kind: "ready",
        dossier: await assembleDossier({
          root: key,
          subjects: [{ key, displayName: key.name, source: "input" }],
          skippedSubjects: [],
          research: {
            state: "initial",
            message:
              "Linked-character research is still running; this evidence covers only the submitted character."
          },
          warcraftLogs: options.warcraftLogs,
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
          requestCap,
          signal: requestSignal
        })
      };
    }
  };
}
