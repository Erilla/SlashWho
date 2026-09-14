import {
  applicantDossierSchema,
  type ApplicantDossier as ContractApplicantDossier,
  type DossierLimitation as ContractDossierLimitation
} from "@slashwho/contracts";
import type {
  DiscoveryQueue,
  Repositories,
  StoredCharacterMythicKill,
  StoredCharacterMythicWipe,
  StoredSnapshotCharacter
} from "@slashwho/database";
import {
  buildApplicantDossier,
  formatCharacterDisplayName,
  canonicalCharacterId,
  lookupCuttingEdgeAchievement,
  lookupRaiderIoBoss,
  parseApplicantCharacterUrl,
  toRaiderIoUrl,
  type CharacterKey,
  type DossierCuttingEdgeEvidence,
  type DossierKillEvidence,
  type DossierWipeEvidence,
  type DossierLimitation
} from "@slashwho/domain";
import type { BlizzardGateway } from "@slashwho/blizzard";
import type {
  MythicBossRanking,
  MythicBossRankingsOptions,
  MythicBossRankingsResult,
  RaiderIoGateway
} from "@slashwho/raiderio";

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
type DossierSubject = Readonly<{
  key: CharacterKey;
  displayName: string;
  className: string | null;
  raiderIoUrl: string;
  source: StoredSnapshotCharacter["source"] | "submitted";
}>;
type EvidenceResult = Readonly<{
  kills: readonly DossierKillEvidence[];
  wipes: readonly DossierWipeEvidence[];
  warcraftLogsComplete: boolean;
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
  if (source === "raiderio") {
    const reason =
      code === "schema_changed"
        ? "an unexpected response"
        : code === "rate_limited"
          ? "rate limiting"
          : code === "not_found"
            ? "a missing leaderboard"
            : code === "private"
              ? "denied leaderboard access"
              : "a lookup failure";
    return `Some historic boss world ranks could not be checked because of ${reason} from Raider.IO. Verified kill evidence is still shown.`;
  }
  const label =
    source === "blizzard" ? "Blizzard achievement data" : "Warcraft Logs";
  switch (code) {
    case "not_found":
      return `${label} has no public evidence for this character.`;
    case "private":
      return `${label} evidence for this character is private.`;
    case "rate_limited":
      return `${label} is temporarily rate limited.`;
    case "request_cap":
      return `${label} history is incomplete because this dossier reached its request cap. Shown evidence is partial; other kills or wipes may exist.`;
    case "unavailable":
      if (source === "blizzard")
        return `${label} could not be read; Cutting Edge status is unknown for this character.`;
      return `${label} history could not be fully loaded. Shown evidence is partial; other kills or wipes may exist.`;
    case "schema_changed":
      return `${label} returned an unexpected response, so history is incomplete. Shown evidence is partial; other kills or wipes may exist.`;
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

function blizzardLimitationCode(
  error: unknown
): "not_found" | "schema_drift" | "unavailable" {
  if (typeof error !== "object" || error === null || !("kind" in error))
    return "unavailable";
  if (error.kind === "not_found" || error.kind === "schema_drift")
    return error.kind;
  return "unavailable";
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
    guild: kill.guild ? { ...kill.guild, region: character.region } : null,
    historicWorldRank: kill.historicWorldRank ?? null,
    reportUrl: kill.fightUrl
  };
}

function cachedWipe(
  wipe: StoredCharacterMythicWipe,
  character: CharacterKey
): DossierWipeEvidence {
  return {
    raidId: wipe.raidId,
    raidName: wipe.raidName,
    bossId: wipe.bossId,
    bossName: wipe.bossName,
    journalBossId: wipe.journalBossId,
    bossOrder: wipe.bossOrder,
    character,
    attemptedAt: wipe.attemptedAt,
    reportUrl: wipe.fightUrl
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
    .then((achievements) => ({ kind: "evidence" as const, achievements }))
    .catch((error: unknown) => {
      if (isAbort(error, options.signal)) throw error;
      return {
        kind: "limitation" as const,
        code: blizzardLimitationCode(error)
      };
    });
  const limitations: DossierLimitation[] = [];
  const completed = reservation.completed;
  if (completed?.run.limitationCode) {
    limitations.push(
      limitation("warcraft_logs", character.key, completed.run.limitationCode)
    );
  }
  if (blizzard.kind === "limitation") {
    limitations.push(limitation("blizzard", character.key, blizzard.code));
  }
  return {
    limitations,
    kills:
      completed?.kills.map((kill) => cachedKill(kill, character.key)) ?? [],
    wipes:
      completed?.wipes.map((wipe) => cachedWipe(wipe, character.key)) ?? [],
    warcraftLogsComplete:
      reservation.kind === "fresh" &&
      completed?.run.status === "complete" &&
      completed.run.limitationCode === null &&
      completed.wipeCapable,
    cuttingEdges:
      blizzard.kind === "evidence"
        ? blizzard.achievements.map((achievement) => ({
            ...achievement,
            character: character.key
          }))
        : [],
    gathering: reservation.kind !== "fresh"
  };
}

function serializeDossierSubject(character: DossierSubject) {
  return {
    key: character.key,
    displayName: formatCharacterDisplayName(character.displayName),
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
      (!ranking.bossSlug ||
        ranking.bossSlug ===
          lookupRaiderIoBoss(kill.raidName, kill.bossName)?.bossSlug) &&
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

function rankingKey(options: MythicBossRankingsOptions): string {
  return JSON.stringify(
    options.guild
      ? [
          options.raidSlug,
          options.guild.region,
          options.guild.realm,
          options.guild.name
        ]
      : [options.raidSlug, options.bossSlug]
  );
}

function guildRankingRequest(
  kill: DossierKillEvidence
): MythicBossRankingsOptions | null {
  if (!kill.guild) return null;
  const boss = lookupRaiderIoBoss(kill.raidName, kill.bossName);
  return boss
    ? { ...boss, guild: { ...kill.guild, region: kill.character.region } }
    : null;
}

async function enrichHistoricRanks(options: {
  kills: readonly DossierKillEvidence[];
  raiderio: Pick<RaiderIoGateway, "getMythicBossRankings">;
  signal: AbortSignal;
}): Promise<{
  kills: readonly DossierKillEvidence[];
  limitations: readonly DossierLimitation[];
}> {
  const rankings = new Map<string, readonly MythicBossRanking[]>();
  const failures = new Map<string, DossierLimitation>();
  const requests = new Map<string, MythicBossRankingsOptions>();
  for (const kill of options.kills) {
    if (!kill.guild) continue;
    const boss = guildRankingRequest(kill);
    if (boss) requests.set(rankingKey(boss), boss);
  }
  await Promise.all(
    [...requests.entries()].map(async ([key, boss]) => {
      const result = await options.raiderio.getMythicBossRankings(
        boss,
        options.signal
      );
      if (result.kind === "rankings") rankings.set(key, result.rows);
      else
        failures.set(result.code, {
          source: "raiderio",
          character: null,
          code: result.code
        });
    })
  );
  const kills = options.kills.map((kill) => {
    const boss = guildRankingRequest(kill);
    if (!boss) return kill;
    const rows = rankings.get(rankingKey(boss));
    return rows
      ? { ...kill, historicWorldRank: historicRank(kill, rows) }
      : kill;
  });
  return {
    kills,
    limitations: [...failures.values()].sort((a, b) =>
      a.code.localeCompare(b.code)
    )
  };
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
  const ranked = await enrichHistoricRanks({
    kills: evidence.flatMap((item) => item.kills),
    raiderio: options.raiderio,
    signal: options.signal
  });
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
    kills: ranked.kills,
    wipes: evidence.flatMap((item) => item.wipes),
    completeWarcraftLogsCharacters: evidence.flatMap((item, index) =>
      item.warcraftLogsComplete ? [options.subjects[index]!.key] : []
    ),
    cuttingEdges: evidence.flatMap((item) => item.cuttingEdges),
    limitations: [...limitations, ...ranked.limitations]
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

class RankingLookupFailure extends Error {
  constructor(
    readonly result: Extract<MythicBossRankingsResult, { kind: "limitation" }>
  ) {
    super("rankings_unavailable");
  }
}

export function createApplicantDossierService(options: {
  repositories: Pick<Repositories, "snapshots" | "evidence">;
  queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
  search: Pick<SearchService, "create">;
  blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
  raiderio: Pick<RaiderIoGateway, "getMythicBossRankings" | "getCharacter">;
  config: ApplicationConfig;
  onCacheEvent?: (source: string, event: string) => void;
}): ApplicantDossierService {
  const achievements = createBoundedCache<
    Awaited<ReturnType<BlizzardGateway["getCompletedAchievements"]>>
  >({
    ttlMs: 15 * 60_000,
    maxEntries: 1_000,
    observe: (event) => options.onCacheEvent?.("blizzard_cutting_edge", event)
  });
  const rankings = createBoundedCache<
    Awaited<ReturnType<RaiderIoGateway["getMythicBossRankings"]>>
  >({
    ttlMs: 15 * 60_000,
    maxEntries: 256,
    observe: (event) => options.onCacheEvent?.("raiderio_rankings", event)
  });
  const blizzard: Pick<BlizzardGateway, "getCompletedAchievements"> = {
    async getCompletedAchievements(key, signal) {
      signal?.throwIfAborted();
      const result = await achievements(
        `${key.region}/${key.realm}/${key.name}`,
        async () => {
          const rows = await options.blizzard.getCompletedAchievements(
            key,
            AbortSignal.timeout(15_000)
          );
          return rows
            .filter(
              (row) => lookupCuttingEdgeAchievement(row.achievementId) !== null
            )
            .map(({ achievementId, completedAt }) => ({
              achievementId,
              completedAt
            }));
        }
      );
      signal?.throwIfAborted();
      return result;
    }
  };
  const raiderio: Pick<RaiderIoGateway, "getMythicBossRankings"> = {
    async getMythicBossRankings(boss, signal) {
      signal?.throwIfAborted();
      try {
        const result = await rankings(rankingKey(boss), async () => {
          const response = await options.raiderio.getMythicBossRankings(
            boss,
            AbortSignal.timeout(15_000)
          );
          if (response.kind !== "rankings") {
            options.onCacheEvent?.(
              "raiderio_rankings",
              `failure_${response.code}`
            );
            throw new RankingLookupFailure(response);
          }
          return response;
        });
        signal?.throwIfAborted();
        return result;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof RankingLookupFailure) return error.result;
        return { kind: "limitation", code: "unavailable" };
      }
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
      // Initial evidence precedes the worker's snapshot filter. One bounded
      // lookup prevents that preview from exposing a tournament root.
      const timeout = AbortSignal.timeout(15_000);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      try {
        requestSignal.throwIfAborted();
        const character = await options.raiderio.getCharacter(
          key,
          requestSignal
        );
        requestSignal.throwIfAborted();
        if (character.isTournamentProfile === true)
          return { kind: "not_ready" };
      } catch {
        signal?.throwIfAborted();
        return { kind: "not_ready" };
      }
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
          blizzard,
          raiderio,
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

      const rootId = canonicalCharacterId(snapshot.rootKey);
      // Rank before applying the cap so the displayed list and evidence requests
      // prioritise the same characters without changing the immutable snapshot.
      const ordered = [...snapshot.characters].sort((left, right) => {
        const rootOrder =
          Number(canonicalCharacterId(right.key) === rootId) -
          Number(canonicalCharacterId(left.key) === rootId);
        return (
          rootOrder ||
          right.level - left.level ||
          left.key.region.localeCompare(right.key.region, "en") ||
          left.key.realm.localeCompare(right.key.realm, "en") ||
          left.key.name.localeCompare(right.key.name, "en")
        );
      });
      const selected = ordered.slice(0, options.config.DOSSIER_CHARACTER_CAP);
      const skipped = ordered.slice(selected.length);
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
          blizzard,
          raiderio,
          freshnessCutoff: new Date(
            Date.now() - options.config.FRESHNESS_HOURS * 60 * 60 * 1000
          ),
          signal: signal ?? new AbortController().signal
        })
      };
    }
  };
}
