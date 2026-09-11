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
import type { RaiderIoGateway } from "@slashwho/raiderio";
import type { WarcraftLogsGateway } from "@slashwho/warcraftlogs";

import type { ApplicationConfig } from "./config";
import { serializeDossierCharacter } from "./serializers";
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
  read(key: CharacterKey, signal?: AbortSignal): Promise<ReadDossierResult>;
}

type EvidenceSource = "raiderio" | "warcraft_logs";
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
      return `${label} is temporarily unavailable.`;
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

function reportUrlFor(
  character: CharacterKey,
  bossId: string,
  killedAt: string,
  reports: readonly Readonly<{
    encounterId: number;
    killedAt: string;
    reportUrl: string;
  }>[]
): string | null {
  const report = reports.find(
    (candidate) =>
      candidate.encounterId.toString() === bossId &&
      candidate.killedAt === killedAt
  );
  return report?.reportUrl ?? null;
}

function tierOrdinals(cap: number): readonly number[] {
  return Array.from({ length: cap }, (_, ordinal) => ordinal);
}

async function gatherCharacterEvidence(
  character: StoredSnapshotCharacter,
  options: {
    raiderIo: Pick<RaiderIoGateway, "getHistoricMythicKills">;
    warcraftLogs: Pick<WarcraftLogsGateway, "getFirstKillReports">;
    config: ApplicationConfig;
    signal?: AbortSignal;
  }
): Promise<EvidenceResult> {
  const [raiderIo, warcraftLogs] = await Promise.all([
    options.raiderIo
      .getHistoricMythicKills(character.key, {
        tierOrdinals: tierOrdinals(options.config.DOSSIER_RAIDERIO_TIER_CAP),
        requestCap: options.config.DOSSIER_RAIDERIO_TIER_CAP,
        signal: options.signal
      })
      .catch((error: unknown) => {
        if (isAbort(error, options.signal)) throw error;
        return { kind: "limitation" as const, code: "unavailable" as const };
      }),
    options.warcraftLogs
      .getFirstKillReports(character.key, {
        requestCap: options.config.DOSSIER_WARCRAFT_LOGS_REQUEST_CAP,
        signal: options.signal
      })
      .catch((error: unknown) => {
        if (isAbort(error, options.signal)) throw error;
        return { kind: "limitation" as const, code: "unavailable" as const };
      })
  ]);
  const limitations: DossierLimitation[] = [];
  if (raiderIo.kind === "limitation") {
    limitations.push(limitation("raiderio", character.key, raiderIo.code));
  }
  if (warcraftLogs.kind === "limitation") {
    limitations.push(
      limitation("warcraft_logs", character.key, warcraftLogs.code)
    );
  }
  if (raiderIo.kind !== "evidence") return { kills: [], limitations };

  const reports = warcraftLogs.kind === "evidence" ? warcraftLogs.reports : [];
  return {
    limitations,
    kills: raiderIo.kills.map((kill) => ({
      raidId: kill.raidId,
      raidName: kill.raidName,
      bossId: kill.bossId,
      bossName: kill.bossName,
      bossOrder: kill.bossOrder,
      isFinalBoss: kill.isFinalBoss,
      character: character.key,
      killedAt: kill.firstDefeated,
      guild: kill.guild,
      historicWorldRank: kill.historicWorldRank,
      reportUrl: reportUrlFor(
        character.key,
        kill.bossId,
        kill.firstDefeated,
        reports
      )
    }))
  };
}

export function createApplicantDossierService(options: {
  repositories: Pick<Repositories, "snapshots">;
  search: Pick<SearchService, "create">;
  raiderIo: Pick<RaiderIoGateway, "getHistoricMythicKills">;
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

    async read(key, signal) {
      const snapshot = await options.repositories.snapshots.getCurrent(key);
      if (!snapshot) return { kind: "not_ready" };

      const selected = snapshot.characters.slice(
        0,
        options.config.DOSSIER_CHARACTER_CAP
      );
      const skipped = snapshot.characters.slice(selected.length);
      const evidence = await Promise.all(
        selected.map((character) =>
          gatherCharacterEvidence(character, {
            raiderIo: options.raiderIo,
            warcraftLogs: options.warcraftLogs,
            config: options.config,
            signal
          })
        )
      );
      const limitations = [
        ...evidence.flatMap((item) => item.limitations),
        ...skipped.flatMap((character) => [
          limitation("raiderio", character.key, "request_cap"),
          limitation("warcraft_logs", character.key, "request_cap")
        ])
      ];
      const dossier = buildApplicantDossier({
        root: snapshot.rootKey,
        characters: selected.map(({ key: characterKey, displayName }) => ({
          key: characterKey,
          displayName
        })),
        kills: evidence.flatMap((item) => item.kills),
        limitations
      });
      return {
        kind: "ready",
        dossier: applicantDossierSchema.parse({
          ...dossier,
          characters: selected.map(serializeDossierCharacter),
          limitations: dossier.limitations.map((item) => ({
            ...item,
            code: contractLimitationCode(item.code),
            message: limitationMessage(
              item.source,
              contractLimitationCode(item.code)
            )
          }))
        })
      };
    }
  };
}
