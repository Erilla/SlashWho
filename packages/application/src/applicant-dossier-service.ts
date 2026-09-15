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
  isAccountWideCuttingEdgeAchievement,
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
import { encryptCredential } from "./credential-encryption";
import { createConcurrencyLimiter } from "./concurrency";
import type {
  CreateSearchCommand,
  CreateSearchResult,
  SearchService
} from "./search-service";

export type CreateDossierCommand = CreateSearchCommand;
export type CreateDossierResult = CreateSearchResult;
export type ReadDossierResult =
  { kind: "ready"; dossier: ContractApplicantDossier } | { kind: "not_ready" };

/**
 * Visitor-supplied credentials for a single dossier read. Gateways built from
 * these keys are used directly, never through the caches shared by every other
 * visitor, so one visitor's key budget can neither fill nor be billed for
 * another's results.
 */
export type DossierGatewayOverrides = Readonly<{
  blizzard?: Pick<BlizzardGateway, "getCompletedAchievements">;
  raiderio?: Pick<RaiderIoGateway, "getMythicBossRankings" | "getCharacter">;
  wclCredentials?: WclCredentials | null;
}>;

type WclCredentials = Readonly<{ clientId: string; clientSecret: string }>;

export interface ApplicantDossierService {
  start(input: CreateDossierCommand): Promise<CreateDossierResult>;
  addConnectedCharacter(
    root: CharacterKey,
    input: CreateDossierCommand
  ): Promise<CreateSearchResult | { kind: "linked" | "duplicate" }>;
  readInitial(
    key: CharacterKey,
    signal?: AbortSignal,
    overrides?: DossierGatewayOverrides
  ): Promise<ReadDossierResult>;
  read(
    key: CharacterKey,
    signal?: AbortSignal,
    overrides?: DossierGatewayOverrides
  ): Promise<ReadDossierResult>;
}

type EvidenceSource = "raiderio" | "warcraft_logs" | "blizzard";
type DossierSubject = Readonly<{
  key: CharacterKey;
  displayName: string;
  className: string | null;
  raiderIoUrl: string;
  source: StoredSnapshotCharacter["source"] | "submitted" | "manually_added";
}>;
type DossierEvidenceState = "waiting" | "scanning" | "complete" | "partial";
type EvidenceResult = Readonly<{
  kills: readonly DossierKillEvidence[];
  wipes: readonly DossierWipeEvidence[];
  warcraftLogsComplete: boolean;
  limitations: readonly DossierLimitation[];
  evidenceState: DossierEvidenceState;
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
  if (source === "warcraft_logs" && code.startsWith("parse_")) {
    const reason =
      code === "parse_private"
        ? "the supporting reports are private"
        : code === "parse_rate_limited"
          ? "Warcraft Logs is temporarily rate limited"
          : code === "parse_request_cap"
            ? "this dossier reached its parse request cap"
            : code === "parse_schema_drift"
              ? "Warcraft Logs returned an unexpected ranking response"
              : "Warcraft Logs could not load the rankings";
    return `Parse availability is partial because ${reason}. Verified kill evidence is still shown.`;
  }
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
    case "current_content_window_unknown":
      return `${label} evidence could not be shown because this raid's current-content window has not been reviewed.`;
    case "current_content_evidence_withheld":
      return `${label} evidence outside this raid's current-content window is not shown.`;
    default:
      return `${label} parse availability is partial. Verified kill evidence is still shown.`;
  }
}

function limitation(
  source: EvidenceSource,
  character: CharacterKey,
  code: string,
  observedAt: Date = new Date(),
  retryAfterAt?: Date | null
): DossierLimitation {
  return {
    source,
    character,
    code: contractLimitationCode(code),
    observedAt: observedAt.toISOString(),
    ...(retryAfterAt && !Number.isNaN(retryAfterAt.valueOf())
      ? { retryAt: retryAfterAt.toISOString() }
      : {})
  };
}

function retryAfterAt(error: unknown): Date | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("retryAfterMs" in error) ||
    typeof error.retryAfterMs !== "number" ||
    !Number.isFinite(error.retryAfterMs)
  ) {
    return null;
  }
  return new Date(Date.now() + Math.max(0, error.retryAfterMs));
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
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
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
    reportUrl: kill.fightUrl,
    performance: kill.performance
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
    freshnessCutoff: Date;
    signal?: AbortSignal;
    wclCredentials?: WclCredentials | null;
    encryptionKey: Buffer;
  }
): Promise<EvidenceResult & { gathering: boolean }> {
  const reservation = await options.repositories.evidence.reserve({
    key: character.key,
    freshnessCutoff: options.freshnessCutoff,
    at: new Date(),
    credentials: options.wclCredentials
      ? {
          wclClientIdEncrypted: encryptCredential(
            options.wclCredentials.clientId,
            options.encryptionKey
          ),
          wclClientSecretEncrypted: encryptCredential(
            options.wclCredentials.clientSecret,
            options.encryptionKey
          )
        }
      : null
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
  const limitations: DossierLimitation[] = [];
  const completed = reservation.completed;
  if (completed?.run.limitationCode) {
    limitations.push(
      limitation(
        "warcraft_logs",
        character.key,
        completed.run.limitationCode,
        completed.run.completedAt ?? new Date(),
        completed.run.retryAfterAt
      )
    );
  }
  if (completed?.run.parseLimitationCode) {
    limitations.push(
      limitation(
        "warcraft_logs",
        character.key,
        completed.run.parseLimitationCode,
        completed.run.completedAt ?? new Date(),
        completed.run.retryAfterAt
      )
    );
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
    gathering: reservation.kind !== "fresh",
    evidenceState:
      reservation.kind === "fresh"
        ? completed?.run.status === "partial"
          ? "partial"
          : "complete"
        : reservation.run.status === "running"
          ? "scanning"
          : "waiting"
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
    if (character.source === "fingerprint" && fingerprintAccountEstablished)
      continue;
    try {
      const achievements = await options.blizzard.getCompletedAchievements(
        character.key,
        options.signal
      );
      const supported = achievements.filter((achievement) =>
        isAccountWideCuttingEdgeAchievement(achievement.achievementId)
      );
      cuttingEdges.push(...supported);
      if (character.source !== "claimed" && supported.length > 0) {
        fingerprintAccountEstablished = true;
      }
    } catch (error) {
      if (isAbort(error, options.signal)) throw error;
      limitations.push(
        limitation(
          "blizzard",
          character.key,
          blizzardLimitationCode(error),
          new Date(),
          retryAfterAt(error)
        )
      );
    }
  }
  return { cuttingEdges, limitations };
}

function serializeDossierSubject(
  character: DossierSubject,
  evidenceState?: DossierEvidenceState
) {
  return {
    key: character.key,
    displayName: formatCharacterDisplayName(character.displayName),
    className: character.className,
    raiderIoUrl: character.raiderIoUrl,
    source:
      character.source === "submitted"
        ? ("submitted" as const)
        : character.source === "manually_added"
          ? ("manually_added" as const)
          : character.source === "fingerprint"
            ? ("fingerprint_derived" as const)
            : ("raiderio_declared" as const),
    ...(evidenceState
      ? {
          evidenceState,
          researchState:
            evidenceState === "complete" || evidenceState === "partial"
              ? ("complete" as const)
              : ("gathering" as const)
        }
      : {})
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
  concurrency: ReturnType<typeof createConcurrencyLimiter>;
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
      const result = await options.concurrency.run(() =>
        options.raiderio.getMythicBossRankings(boss, options.signal)
      );
      if (result.kind === "rankings") rankings.set(key, result.rows);
      else
        failures.set(result.code, {
          source: "raiderio",
          character: null,
          code: result.code,
          observedAt: new Date().toISOString(),
          ...(result.retryAfterMs === undefined
            ? {}
            : {
                retryAt: new Date(
                  Date.now() + Math.max(0, result.retryAfterMs)
                ).toISOString()
              })
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
  concurrency: ReturnType<typeof createConcurrencyLimiter>;

  freshnessCutoff: Date;
  signal: AbortSignal;
  wclCredentials?: WclCredentials | null;
  encryptionKey: Buffer;
}): Promise<ContractApplicantDossier> {
  const [evidence, cuttingEdgeEvidence] = await Promise.all([
    Promise.all(
      options.subjects.map((character) =>
        gatherCharacterEvidence(character, {
          repositories: options.repositories,
          queue: options.queue,
          freshnessCutoff: options.freshnessCutoff,
          signal: options.signal,
          wclCredentials: options.wclCredentials,
          encryptionKey: options.encryptionKey
        })
      )
    ),
    gatherCuttingEdgeEvidence(options.subjects, {
      blizzard: options.blizzard,
      signal: options.signal
    })
  ]);
  const limitations = [
    ...evidence.flatMap((item) => item.limitations),
    ...cuttingEdgeEvidence.limitations,
    ...options.skippedSubjects.map((character) =>
      limitation("warcraft_logs", character.key, "request_cap", new Date())
    )
  ];
  const ranked = await enrichHistoricRanks({
    kills: evidence.flatMap((item) => item.kills),
    raiderio: options.raiderio,
    concurrency: options.concurrency,
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
    cuttingEdges: cuttingEdgeEvidence.cuttingEdges,
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
    characters: options.subjects.map((character, index) =>
      serializeDossierSubject(character, evidence[index]?.evidenceState)
    ),
    limitations: dossier.limitations.map((item) => ({
      ...item,
      observedAt: item.observedAt ?? new Date().toISOString(),
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
  repositories: Pick<
    Repositories,
    "snapshots" | "evidence" | "manualConnections"
  >;
  queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
  search: Pick<SearchService, "create">;
  blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
  raiderio: Pick<RaiderIoGateway, "getMythicBossRankings" | "getCharacter">;
  config: ApplicationConfig;
  evidenceJobCredentialEncryptionKey: Buffer;
  onCacheEvent?: (source: string, event: string) => void;
}): ApplicantDossierService {
  const achievements = createBoundedCache<
    Awaited<ReturnType<BlizzardGateway["getCompletedAchievements"]>>
  >({
    ttlMs: 15 * 60_000,
    maxEntries: 1_000,
    observe: (event) => options.onCacheEvent?.("blizzard_cutting_edge", event)
  });
  const providerConcurrency = createConcurrencyLimiter(
    options.config.DOSSIER_PROVIDER_CONCURRENCY
  );
  const rankings = createBoundedCache<
    Awaited<ReturnType<RaiderIoGateway["getMythicBossRankings"]>>
  >({
    ttlMs: 15 * 60_000,
    maxEntries: 256,
    observe: (event) => options.onCacheEvent?.("raiderio_rankings", event)
  });
  // A null cache is a visitor-supplied gateway: it keeps the shared timeout,
  // filtering and failure semantics while neither reading from nor writing to
  // the caches every other visitor is served from.
  function cuttingEdgeGateway(
    source: Pick<BlizzardGateway, "getCompletedAchievements">,
    cache: typeof achievements | null
  ): Pick<BlizzardGateway, "getCompletedAchievements"> {
    return {
      async getCompletedAchievements(key, signal) {
        signal?.throwIfAborted();
        const load = async () => {
          const rows = await source.getCompletedAchievements(
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
        };
        const result = await awaitWithAbort(
          cache
            ? cache(`${key.region}/${key.realm}/${key.name}`, load)
            : load(),
          signal
        );
        return result;
      }
    };
  }
  function rankingsGateway(
    source: Pick<RaiderIoGateway, "getMythicBossRankings">,
    cache: typeof rankings | null
  ): Pick<RaiderIoGateway, "getMythicBossRankings"> {
    return {
      async getMythicBossRankings(boss, signal) {
        signal?.throwIfAborted();
        const load = async () => {
          const response = await source.getMythicBossRankings(
            boss,
            AbortSignal.timeout(15_000)
          );
          if (response.kind !== "rankings") {
            if (cache) {
              options.onCacheEvent?.(
                "raiderio_rankings",
                `failure_${response.code}`
              );
            }
            throw new RankingLookupFailure(response);
          }
          return response;
        };
        try {
          const result = await (cache ? cache(rankingKey(boss), load) : load());
          signal?.throwIfAborted();
          return result;
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof RankingLookupFailure) return error.result;
          return { kind: "limitation", code: "unavailable" };
        }
      }
    };
  }
  const blizzard = cuttingEdgeGateway(options.blizzard, achievements);
  const raiderio = rankingsGateway(options.raiderio, rankings);
  function gatewaysFor(overrides?: DossierGatewayOverrides) {
    return {
      blizzard: overrides?.blizzard
        ? cuttingEdgeGateway(overrides.blizzard, null)
        : blizzard,
      raiderio: overrides?.raiderio
        ? rankingsGateway(overrides.raiderio, null)
        : raiderio
    };
  }
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

    async addConnectedCharacter(root, input) {
      let target: CharacterKey;
      try {
        target = parseApplicantCharacterUrl(input.characterUrl);
      } catch {
        return { kind: "invalid", code: "invalid_character_url" };
      }
      if (canonicalCharacterId(root) === canonicalCharacterId(target))
        return { kind: "duplicate" };
      const result = await options.search.create({
        ...input,
        characterUrl: toRaiderIoUrl(target)
      });
      // Record the link for a queued character too. Connections are stored by
      // key, so this survives until discovery creates the character and the
      // dossier resolves it without a second attempt. Anything other than a
      // started search — invalid, suppressed, rate limited — links nothing.
      if (result.kind !== "character" && result.kind !== "job") return result;
      const connection = await options.repositories.manualConnections.add(
        root,
        target
      );
      if (result.kind === "job") return result;
      return { kind: connection === "added" ? "linked" : "duplicate" };
    },

    async readInitial(key, signal, overrides) {
      // Initial evidence precedes the worker's snapshot filter. One bounded
      // lookup prevents that preview from exposing a tournament root.
      const timeout = AbortSignal.timeout(15_000);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      const profiles = overrides?.raiderio ?? options.raiderio;
      try {
        requestSignal.throwIfAborted();
        const character = await profiles.getCharacter(key, requestSignal);
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
          ...gatewaysFor(overrides),
          concurrency: providerConcurrency,
          freshnessCutoff: new Date(
            Date.now() - options.config.FRESHNESS_HOURS * 60 * 60 * 1000
          ),
          signal: signal ?? new AbortController().signal,
          wclCredentials: overrides?.wclCredentials,
          encryptionKey: options.evidenceJobCredentialEncryptionKey
        })
      };
    },

    async read(key, signal, overrides) {
      const snapshot =
        (await options.repositories.snapshots.getCurrent(key)) ??
        (await options.repositories.snapshots.getCurrentContainingCharacter?.(
          key
        ));
      if (!snapshot) return { kind: "not_ready" };

      const seen = new Set(
        snapshot.characters.map((character) =>
          canonicalCharacterId(character.key)
        )
      );
      // A manually connected character is a full participant, not a lone row.
      // Adding it starts a discovery run rooted at that character, which walks
      // its Raider.IO alts and fingerprints its Blizzard guild roster, so merge
      // that snapshot in as well. The root's own snapshot stays untouched: a
      // dossier is a view of the moment rather than a stored record.
      // Level only orders the list; it is not part of a dossier subject.
      type RankedSubject = DossierSubject & Readonly<{ level: number }>;
      const manual: RankedSubject[] = [];
      for (const character of await options.repositories.manualConnections.list(
        snapshot.rootKey
      )) {
        const admit = (candidate: RankedSubject) => {
          const id = canonicalCharacterId(candidate.key);
          if (seen.has(id)) return;
          seen.add(id);
          manual.push(candidate);
        };
        admit({ ...character, source: "manually_added" });
        // An undiscovered character has no snapshot to merge yet. Its own run
        // is still queued, and the next read picks the characters up.
        if (character.pending) continue;
        const connectedSnapshot =
          await options.repositories.snapshots.getCurrent(character.key);
        for (const discovered of connectedSnapshot?.characters ?? []) {
          admit(discovered);
        }
      }

      const rootId = canonicalCharacterId(snapshot.rootKey);
      // Rank before applying the cap so the displayed list and evidence requests
      // prioritise the same characters without changing the immutable snapshot.
      const ordered = [...snapshot.characters, ...manual].sort(
        (left, right) => {
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
        }
      );
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
          ...gatewaysFor(overrides),
          concurrency: providerConcurrency,
          freshnessCutoff: new Date(
            Date.now() - options.config.FRESHNESS_HOURS * 60 * 60 * 1000
          ),
          signal: signal ?? new AbortController().signal,
          wclCredentials: overrides?.wclCredentials,
          encryptionKey: options.evidenceJobCredentialEncryptionKey
        })
      };
    }
  };
}
