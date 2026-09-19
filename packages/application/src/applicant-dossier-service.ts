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
  StoredCharacterTierBestParse,
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
  type CharacterGuild,
  type CharacterKey,
  type DossierCuttingEdgeEvidence,
  type DossierKillEvidence,
  type DossierWipeEvidence,
  type DossierTierBestParse,
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
import { createBoundedCache, type BoundedCacheOutcome } from "./bounded-cache";
import { encryptCredential } from "./credential-encryption";
import {
  refreshCharacter,
  type RefreshCharacterResult
} from "./refresh-character";

/**
 * How long after a collection a manual refresh does the light path instead.
 * Deliberately invisible: pressing inside it still looks for a new raid night
 * rather than refusing.
 */
const REFRESH_COOLDOWN_MS = 15 * 60 * 1000;
import { createConcurrencyLimiter } from "./concurrency";
import { measuredRepositories } from "./measured-repositories";
import type { MeasurementScope } from "./measurement";
import type {
  CreateSearchCommand,
  CreateSearchResult,
  SearchService
} from "./search-service";

export type CreateDossierCommand = CreateSearchCommand;
export type CreateDossierResult = CreateSearchResult;
export type ReadDossierResult =
  { kind: "ready"; dossier: ContractApplicantDossier } | { kind: "not_ready" };
/** `missing` covers a link another reviewer has already removed. */
export type ConnectedCharacterExclusionResult =
  | { kind: "updated" }
  | { kind: "missing" }
  | { kind: "invalid"; code: "invalid_character_url" };
export type ConnectedCharacterRemovalResult =
  | { kind: "removed" }
  | { kind: "missing" }
  | { kind: "invalid"; code: "invalid_character_url" };

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
  start(
    input: CreateDossierCommand,
    scope?: MeasurementScope
  ): Promise<CreateDossierResult>;
  addConnectedCharacter(
    root: CharacterKey,
    input: CreateDossierCommand,
    scope?: MeasurementScope
  ): Promise<CreateSearchResult | { kind: "linked" | "duplicate" }>;
  readInitial(
    key: CharacterKey,
    signal?: AbortSignal,
    overrides?: DossierGatewayOverrides,
    scope?: MeasurementScope
  ): Promise<ReadDossierResult>;
  read(
    key: CharacterKey,
    signal?: AbortSignal,
    overrides?: DossierGatewayOverrides,
    scope?: MeasurementScope
  ): Promise<ReadDossierResult>;
  setConnectedCharacterExclusion(
    root: CharacterKey,
    input: { characterUrl: string; excluded: boolean },
    scope?: MeasurementScope
  ): Promise<ConnectedCharacterExclusionResult>;
  removeConnectedCharacter(
    root: CharacterKey,
    input: { characterUrl: string },
    scope?: MeasurementScope
  ): Promise<ConnectedCharacterRemovalResult>;
  /**
   * Re-collects one character on demand, without the evidence-version bump
   * that would sweep every character at once.
   */
  refreshCharacter(
    key: CharacterKey,
    scope?: MeasurementScope
  ): Promise<RefreshCharacterResult>;
  /**
   * Forgets every terminal mark for one character, so its history is collected
   * again over as many runs as the points allowance allows.
   *
   * Operator-only, and deliberately not reachable from the unauthenticated
   * dossier refresh route: one press there costs one run, and a rebuild costs
   * a whole history.
   */
  rebuildCharacter(
    key: CharacterKey,
    scope?: MeasurementScope
  ): Promise<RefreshCharacterResult>;
}

type EvidenceSource = "raiderio" | "warcraft_logs" | "blizzard";
type DossierSubject = Readonly<{
  key: CharacterKey;
  displayName: string;
  className: string | null;
  guild: CharacterGuild | null;
  raiderIoUrl: string;
  source: StoredSnapshotCharacter["source"] | "submitted" | "manually_added";
}>;
type DossierEvidenceState = "waiting" | "scanning" | "complete" | "partial";
type EvidenceResult = Readonly<{
  kills: readonly DossierKillEvidence[];
  wipes: readonly DossierWipeEvidence[];
  tierBests: readonly DossierTierBestParse[];
  warcraftLogsComplete: boolean;
  limitations: readonly DossierLimitation[];
  evidenceState: DossierEvidenceState;
  /** When this character's evidence last finished collecting. */
  collectedAt: Date | null;
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
    // The cap is not a verdict. Since #280 a capped run sets a retry and
    // resumes, so wording that read as terminal described the opposite of
    // what happens next; it clears itself once a later run publishes without
    // the code (#297).
    if (code === "parse_request_cap") {
      return (
        "Parse availability is partial because this dossier reached its " +
        "parse request cap. Collection resumes automatically and fills in " +
        "the rest; verified kill evidence is still shown."
      );
    }
    const reason =
      code === "parse_private"
        ? "the supporting reports are private"
        : code === "parse_rate_limited"
          ? "Warcraft Logs is temporarily rate limited"
          : code === "parse_schema_drift"
            ? "Warcraft Logs returned an unexpected ranking response"
            : // Not a fault, most of the time: the usual way here is a
              // character who was in the fight and simply not ranked in it.
              // Saying "unexpected response" of that would be alarming and
              // wrong, which is half of why #349 split the two codes.
              code === "parse_identity_unmatched"
              ? "Warcraft Logs ranked nobody matching this character in those reports"
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
    case "unmatched_encounter":
      return `${label} reported Mythic kills this dossier could not match to a known raid boss, so they are not shown. Other kills may exist.`;
    case "not_found":
      return `${label} has no public evidence for this character.`;
    case "private":
      return `${label} evidence for this character is private.`;
    case "rate_limited":
      return `${label} is temporarily rate limited.`;
    case "points_budget_low":
      return `${label} collection was deferred because this dossier's hourly points allowance is nearly spent. It resumes automatically once the allowance resets; shown evidence is partial.`;
    case "collection_failed":
      return `${label} collection was interrupted by an error before it could be stored. Shown evidence is partial and collection is retried automatically; other kills or wipes may exist.`;
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

function cachedTierBest(
  tierBest: StoredCharacterTierBestParse,
  character: CharacterKey
): DossierTierBestParse {
  return {
    raidName: tierBest.raidName,
    bossName: tierBest.bossName,
    character,
    rankingsUrl: tierBest.rankingsUrl,
    performance: tierBest.performance
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
      reservation.run.id,
      { enqueuedAt: new Date().toISOString() }
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
  // The run that is collecting right now, not the last one that finished. A
  // points-budget refusal publishes nothing, so a deferral exists only here --
  // without this the reader sees an indefinite "collecting" and no reason for
  // it. `claim` clears the code, so it never describes a healthy attempt.
  const active = reservation.active;
  if (active?.limitationCode && active.id !== completed?.run.id) {
    limitations.push(
      limitation(
        "warcraft_logs",
        character.key,
        active.limitationCode,
        active.startedAt ?? active.createdAt,
        active.retryAfterAt
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
    collectedAt: completed?.run.completedAt ?? null,
    kills:
      completed?.kills.map((kill) => cachedKill(kill, character.key)) ?? [],
    wipes:
      completed?.wipes.map((wipe) => cachedWipe(wipe, character.key)) ?? [],
    tierBests:
      completed?.tierBests.map((tierBest) =>
        cachedTierBest(tierBest, character.key)
      ) ?? [],
    // Negative conclusions rest on the history scan, which `limitationCode`
    // reports. A run whose only shortfall is its parse budget scanned the whole
    // history and publishes `partial` to say so, so requiring `complete` here
    // would silently withdraw conclusions the evidence still supports.
    warcraftLogsComplete:
      reservation.kind === "fresh" &&
      (completed?.run.status === "complete" ||
        (completed?.run.status === "partial" &&
          completed.run.parseLimitationCode !== null)) &&
      completed.run.limitationCode === null &&
      completed.wipeCapable,
    // Keyed on the run, not on `kind`: a refresh forces a collection past the
    // freshness window, so the read that should report "Collecting..." is
    // exactly the one whose stored evidence is still fresh. `evidenceState`
    // below stays keyed on `kind` -- fresh evidence does not become incomplete
    // because a refresh is running over it.
    gathering: reservation.active !== null,
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

type CuttingEdgeOutcome =
  | Readonly<{
      kind: "evidence";
      supported: readonly DossierCuttingEdgeEvidence[];
      /** True when this subject alone settles the account for the tail. */
      establishes: boolean;
    }>
  | Readonly<{ kind: "limitation"; limitation: DossierLimitation }>
  | Readonly<{ kind: "abort"; error: unknown }>;

/**
 * Two phases rather than one serial loop.
 *
 * The sequencing this replaces was protecting one thing: once a subject
 * yields an account-wide achievement, the remaining `fingerprint` subjects
 * are redundant. But the two halves of that rule are asymmetric. Only
 * `fingerprint` subjects are ever skipped, while every source except
 * `claimed` can establish the account. So every non-`fingerprint` subject is
 * a pure producer of the flag and never a consumer of it: nothing it learns
 * depends on what ran before it, and serialising them buys nothing.
 *
 * Phase 1 therefore fans all non-`fingerprint` subjects out under the shared
 * provider limiter. Phase 2 keeps the `fingerprint` tail sequential, because
 * each of those can still establish the account for the rest -- and skips it
 * outright when phase 1 already did, which saves the calls rather than
 * merely reordering them.
 */
async function gatherCuttingEdgeEvidence(
  subjects: readonly DossierSubject[],
  options: {
    blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
    concurrency: ReturnType<typeof createConcurrencyLimiter>;
    signal?: AbortSignal;
  }
): Promise<CuttingEdgeEvidenceResult> {
  // Never throws: an abort is returned as an outcome so a concurrent batch
  // can be settled in full before it is rethrown. A bare rethrow would leave
  // this subject's siblings in flight and their rejections unhandled.
  async function read(character: DossierSubject): Promise<CuttingEdgeOutcome> {
    try {
      const achievements = await options.concurrency.run(() =>
        options.blizzard.getCompletedAchievements(character.key, options.signal)
      );
      const supported = achievements.filter((achievement) =>
        isAccountWideCuttingEdgeAchievement(achievement.achievementId)
      );
      return {
        kind: "evidence",
        supported,
        establishes: character.source !== "claimed" && supported.length > 0
      };
    } catch (error) {
      if (isAbort(error, options.signal)) return { kind: "abort", error };
      return {
        kind: "limitation",
        limitation: limitation(
          "blizzard",
          character.key,
          blizzardLimitationCode(error),
          new Date(),
          retryAfterAt(error)
        )
      };
    }
  }

  const leading: number[] = [];
  const tail: number[] = [];
  subjects.forEach((character, index) =>
    (character.source === "fingerprint" ? tail : leading).push(index)
  );

  // Indexed by the subject's own position, never appended on completion: a
  // concurrent batch settles in whatever order the provider answers, and the
  // dossier's limitation ordering is part of what a reviewer reads.
  const outcomes = new Array<CuttingEdgeOutcome | undefined>(subjects.length);
  await Promise.all(
    leading.map(async (index) => {
      outcomes[index] = await read(subjects[index]!);
    })
  );
  // Settled in full above, so rethrowing here abandons nothing in flight.
  // The first abort in subject order is chosen so the rejection is the same
  // one whatever order the batch happened to settle in.
  const aborted = outcomes.find((outcome) => outcome?.kind === "abort");
  if (aborted?.kind === "abort") throw aborted.error;

  let fingerprintAccountEstablished = outcomes.some(
    (outcome) => outcome?.kind === "evidence" && outcome.establishes
  );
  for (const index of tail) {
    if (fingerprintAccountEstablished) break;
    const outcome = await read(subjects[index]!);
    if (outcome.kind === "abort") throw outcome.error;
    outcomes[index] = outcome;
    if (outcome.kind === "evidence" && outcome.establishes) {
      fingerprintAccountEstablished = true;
    }
  }

  const cuttingEdges: DossierCuttingEdgeEvidence[] = [];
  const limitations: DossierLimitation[] = [];
  for (const outcome of outcomes) {
    if (outcome?.kind === "evidence") cuttingEdges.push(...outcome.supported);
    else if (outcome?.kind === "limitation")
      limitations.push(outcome.limitation);
  }
  return { cuttingEdges, limitations };
}

function serializeDossierSubject(
  character: DossierSubject,
  evidence?: { evidenceState: DossierEvidenceState; gathering: boolean },
  excluded = false
) {
  return {
    key: character.key,
    displayName: formatCharacterDisplayName(character.displayName),
    className: character.className,
    guild: character.guild,
    raiderIoUrl: character.raiderIoUrl,
    source:
      character.source === "submitted"
        ? ("submitted" as const)
        : character.source === "manually_added"
          ? ("manually_added" as const)
          : character.source === "fingerprint"
            ? ("fingerprint_derived" as const)
            : ("raiderio_declared" as const),
    ...(excluded ? { excluded: true as const } : {}),
    ...(evidence
      ? {
          evidenceState: evidence.evidenceState,
          // Keyed on the run, not on `evidenceState`. A refresh over evidence
          // that is still fresh leaves the stored state `complete`, so
          // deriving the spinner from it left the row static through exactly
          // the collection the page was reporting at the top.
          researchState: evidence.gathering
            ? ("gathering" as const)
            : ("complete" as const)
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
          // A replayed negative-cache entry carries the timestamp of the
          // failure that produced it, so it never looks fresher than it is.
          observedAt: result.observedAt ?? new Date().toISOString(),
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
  /**
   * Manually added characters a reviewer has excluded. They are listed so the
   * exclusion can be reversed, and are kept out of every evidence request and
   * out of `buildApplicantDossier` entirely: an exclusion is a deliberate
   * choice, so it raises no limitation and leaves no catalogue gap.
   */
  excludedSubjects: readonly DossierSubject[];
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
      concurrency: options.concurrency,
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
      ({ key, displayName, className, guild, raiderIoUrl }) => ({
        key,
        displayName,
        className,
        guild,
        raiderIoUrl
      })
    ),
    kills: ranked.kills,
    wipes: evidence.flatMap((item) => item.wipes),
    tierBests: evidence.flatMap((item) => item.tierBests),
    completeWarcraftLogsCharacters: evidence.flatMap((item, index) =>
      item.warcraftLogsComplete ? [options.subjects[index]!.key] : []
    ),
    cuttingEdges: cuttingEdgeEvidence.cuttingEdges,
    limitations: [...limitations, ...ranked.limitations]
  });
  // The oldest of the characters' collections, so the value reads as
  // "everything is at least this fresh" rather than tracking whichever
  // character happened to collect most recently.
  const collectedTimes = evidence.flatMap((item) =>
    item.collectedAt ? [item.collectedAt.getTime()] : []
  );
  return applicantDossierSchema.parse({
    ...dossier,
    lastCollectedAt:
      collectedTimes.length === 0
        ? null
        : new Date(Math.min(...collectedTimes)).toISOString(),
    research: evidence.some((item) => item.gathering)
      ? {
          state: "gathering" as const,
          message:
            "Historic mythic evidence is still gathering in the background. Cached results are shown while it completes."
        }
      : options.research,
    characters: [
      ...options.subjects.map((character, index) =>
        serializeDossierSubject(character, evidence[index])
      ),
      // Excluded rows sit after the researched ones rather than holding their
      // ranked position, so the list reads top-down as evidence then exclusions.
      ...options.excludedSubjects.map((character) =>
        serializeDossierSubject(character, undefined, true)
      )
    ],
    limitations: dossier.limitations.map((item) => ({
      ...item,
      observedAt: item.observedAt ?? new Date().toISOString(),
      code: contractLimitationCode(item.code),
      message: limitationMessage(item.source, contractLimitationCode(item.code))
    }))
  });
}

// Both dossier caches are sized the same way, so the asymmetry that had
// rankings at 256 and achievements at 1,000 cannot silently return: one
// dossier's measured per-key working set times the number of concurrent cold
// reads of distinct rosters that should fit inside the TTL window without
// evicting each other.
//
// Measured from a `test` log capture (see #243): a cold dossier touches ~25
// ranking keys (`raiderIoRankingsCalls` p95 23.6, max 25) and ~10 achievement
// keys.
const DOSSIER_CACHE_TTL_MS = 15 * 60_000;
const RANKING_KEYS_PER_DOSSIER = 25;
const ACHIEVEMENT_KEYS_PER_DOSSIER = 10;
// The multiple is the number of concurrent cold reads of distinct rosters that
// fit inside the 15-minute window before entries start evicting each other.
//
// Replicas are not what this covers. Each `web` replica holds its own
// process-local cache, so replication splits traffic across instances rather
// than crowding one -- it costs hit rate, because every replica cold-loads the
// same keys independently, not capacity per instance.
//
// This also sets each cache's in-flight ceiling, since `createBoundedCache`
// rejects a load once `pending.size` reaches `maxEntries`. That is a far
// backstop at these sizes rather than the operative limit: ranking loads are
// admitted by `providerConcurrency` before they reach the cache, so a read has
// at most `DOSSIER_PROVIDER_CONCURRENCY` in flight, and achievement loads are
// gathered one character at a time. Parallelising that gather (#241) raises
// the achievement cache's in-flight count per read and should re-check this.
const CONCURRENT_COLD_DOSSIERS = 40;

// Maps a bounded cache's per-call outcome onto the requesting scope's own
// counters. Attributed per call (via the cache's optional per-call observer
// parameter), never broadcast to every scope sharing the process-wide cache
// instance -- the same defect already fixed for the concurrency limiter.
const cacheField: Record<string, string> = {
  hit: "cacheHits",
  miss: "cacheMisses",
  shared: "cacheShared",
  failure: "cacheFailures",
  capacity: "cacheCapacity"
};

function cacheObserver(
  scope?: MeasurementScope
): ((event: BoundedCacheOutcome) => void) | undefined {
  if (!scope) return undefined;
  return (event) => {
    scope.increment(cacheField[event] ?? "cacheFailures");
  };
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
    ttlMs: DOSSIER_CACHE_TTL_MS,
    maxEntries: ACHIEVEMENT_KEYS_PER_DOSSIER * CONCURRENT_COLD_DOSSIERS,
    observe: (event) => options.onCacheEvent?.("blizzard_cutting_edge", event)
  });
  // The limiter instance is shared across every request so it actually
  // bounds the fan-out; only the wait *reporting* is per-call, via a
  // scope-bound facade built per readInitial/read call below.
  const providerConcurrency = createConcurrencyLimiter(
    options.config.DOSSIER_PROVIDER_CONCURRENCY
  );
  const rankings = createBoundedCache<
    Awaited<ReturnType<RaiderIoGateway["getMythicBossRankings"]>>
  >({
    ttlMs: DOSSIER_CACHE_TTL_MS,
    // A negative entry occupies the slot its positive counterpart would have:
    // it is keyed by the same `rankingKey`, so remembering failures adds no
    // keys to the working set and the sizing above still holds.
    maxEntries: RANKING_KEYS_PER_DOSSIER * CONCURRENT_COLD_DOSSIERS,
    negativeTtlMs: options.config.NEGATIVE_CACHE_TTL_MS,
    // `unavailable` only. `not_found` and `private` are stable facts about the
    // target and are already handled as such; `rate_limited` carries its own
    // `retryAfterMs`, which a flat negative TTL would fight; and `schema_drift`
    // is a signal we want to keep seeing at full volume rather than suppress.
    cacheFailure: (error) =>
      error instanceof RankingLookupFailure &&
      error.result.code === "unavailable",
    observe: (event) => options.onCacheEvent?.("raiderio_rankings", event)
  });
  // A null cache is a visitor-supplied gateway: it keeps the shared timeout,
  // filtering and failure semantics while neither reading from nor writing to
  // the caches every other visitor is served from.
  //
  // `scope` is the caller's own measurement scope, never a stored one: the
  // gateway is rebuilt per read so provider time is attributed to the single
  // request that spent it, whether that request uses the shared gateway or its
  // own credentials.
  function cuttingEdgeGateway(
    source: Pick<BlizzardGateway, "getCompletedAchievements">,
    cache: typeof achievements | null,
    scope?: MeasurementScope
  ): Pick<BlizzardGateway, "getCompletedAchievements"> {
    return {
      async getCompletedAchievements(key, signal) {
        signal?.throwIfAborted();
        const load = async () => {
          const run = async () =>
            source.getCompletedAchievements(key, AbortSignal.timeout(15_000));
          const rows = scope ? await scope.time("blizzard", run) : await run();
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
            ? cache(
                `${key.region}/${key.realm}/${key.name}`,
                load,
                cacheObserver(scope)
              )
            : load(),
          signal
        );
        return result;
      }
    };
  }
  function rankingsGateway(
    source: Pick<RaiderIoGateway, "getMythicBossRankings">,
    cache: typeof rankings | null,
    scope?: MeasurementScope
  ): Pick<RaiderIoGateway, "getMythicBossRankings"> {
    return {
      async getMythicBossRankings(boss, signal) {
        signal?.throwIfAborted();
        const load = async () => {
          const run = async () =>
            source.getMythicBossRankings(boss, AbortSignal.timeout(15_000));
          const response = scope
            ? await scope.time("raiderIoRankings", run)
            : await run();
          if (response.kind !== "rankings") {
            // The bounded cache's own "failure" outcome already reaches the
            // requesting scope via cacheObserver(scope) below, since this
            // loader throws. The container-level onCacheEvent notification is
            // additive and carries the limitation code; an uncached
            // visitor-supplied gateway reports neither, since it is not part
            // of the shared cache at all.
            if (cache) {
              options.onCacheEvent?.(
                "raiderio_rankings",
                `failure_${response.code}`
              );
            }
            // Stamped here, not where the limitation is serialised: an
            // `unavailable` result may be replayed from the negative cache
            // minutes later, and must keep the age of this observation.
            throw new RankingLookupFailure({
              ...response,
              observedAt: new Date().toISOString()
            });
          }
          return response;
        };
        try {
          const result = await (cache
            ? cache(rankingKey(boss), load, cacheObserver(scope))
            : load());
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
  // Built per call and never captured at construction: this service is a
  // process-wide singleton, so a wrapper held in a closure would attribute one
  // request's queries to another request's scope. The dossier read path is the
  // heaviest database path in the system, so without this it could never report
  // `dbMs` at all.
  function scopedRepositories(
    scope?: MeasurementScope
  ): typeof options.repositories {
    if (!scope) return options.repositories;
    return measuredRepositories(options.repositories, scope);
  }
  // Reports this call's admission wait to its own scope rather than the
  // shared limiter's constructor-level onWait, without cloning the limiter
  // itself: the single shared instance must keep bounding the fan-out.
  function scopedConcurrency(
    scope?: MeasurementScope
  ): Pick<ReturnType<typeof createConcurrencyLimiter>, "run"> {
    if (!scope) return providerConcurrency;
    return {
      run: (work) =>
        providerConcurrency.run(work, (ms) =>
          scope.observe("limiterWaitMs", ms)
        )
    };
  }
  // Both gateways are rebuilt for every read so that the visitor's own
  // credentials and the caller's own measurement scope are applied together.
  // Nothing here is cached across calls.
  function gatewaysFor(
    overrides?: DossierGatewayOverrides,
    scope?: MeasurementScope
  ) {
    return {
      blizzard: cuttingEdgeGateway(
        overrides?.blizzard ?? options.blizzard,
        overrides?.blizzard ? null : achievements,
        scope
      ),
      raiderio: rankingsGateway(
        overrides?.raiderio ?? options.raiderio,
        overrides?.raiderio ? null : rankings,
        scope
      )
    };
  }
  return {
    async start(input, scope) {
      // start does real database and queue work through search.create, so its
      // scope is threaded through rather than discarded: this is the endpoint
      // the research doc measures as "submission to first response".
      try {
        const command = {
          ...input,
          characterUrl: toRaiderIoUrl(
            parseApplicantCharacterUrl(input.characterUrl)
          )
        };
        return scope
          ? options.search.create(command, scope)
          : options.search.create(command);
      } catch {
        return { kind: "invalid", code: "invalid_character_url" };
      }
    },

    async addConnectedCharacter(root, input, scope) {
      let target: CharacterKey;
      try {
        target = parseApplicantCharacterUrl(input.characterUrl);
      } catch {
        return { kind: "invalid", code: "invalid_character_url" };
      }
      if (canonicalCharacterId(root) === canonicalCharacterId(target))
        return { kind: "duplicate" };
      const connectedCommand = {
        ...input,
        characterUrl: toRaiderIoUrl(target)
      };
      const result = scope
        ? await options.search.create(connectedCommand, scope)
        : await options.search.create(connectedCommand);
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

    async setConnectedCharacterExclusion(root, input, scope) {
      let target: CharacterKey;
      try {
        target = parseApplicantCharacterUrl(input.characterUrl);
      } catch {
        return { kind: "invalid", code: "invalid_character_url" };
      }
      const result = await scopedRepositories(
        scope
      ).manualConnections.setExcluded(root, target, input.excluded);
      return result === "updated" ? { kind: "updated" } : { kind: "missing" };
    },

    async removeConnectedCharacter(root, input, scope) {
      let target: CharacterKey;
      try {
        target = parseApplicantCharacterUrl(input.characterUrl);
      } catch {
        return { kind: "invalid", code: "invalid_character_url" };
      }
      const result = await scopedRepositories(scope).manualConnections.remove(
        root,
        target
      );
      return result === "removed" ? { kind: "removed" } : { kind: "missing" };
    },

    async refreshCharacter(key, scope) {
      // Deliberately takes no mode. The reader-facing control is `full` outside
      // the cooldown and `light` inside it, one run either way, and there is no
      // argument a caller could pass to turn it into a rebuild.
      return refreshCharacter({
        key,
        at: new Date(),
        cooldownMs: REFRESH_COOLDOWN_MS,
        repositories: options.repositories,
        queue: options.queue,
        ...(scope ? { scope } : {})
      });
    },

    async rebuildCharacter(key, scope) {
      return refreshCharacter({
        key,
        at: new Date(),
        cooldownMs: REFRESH_COOLDOWN_MS,
        rebuild: true,
        repositories: options.repositories,
        queue: options.queue,
        ...(scope ? { scope } : {})
      });
    },

    async readInitial(key, signal, overrides, scope) {
      const repositories = scopedRepositories(scope);
      // Initial evidence precedes the worker's snapshot filter. One bounded
      // lookup prevents that preview from exposing a tournament root.
      const timeout = AbortSignal.timeout(15_000);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      const profiles = overrides?.raiderio ?? options.raiderio;
      try {
        requestSignal.throwIfAborted();
        // The visitor's own gateway when they supplied one, the shared gateway
        // otherwise; either way the call is timed against this read's scope.
        const loadCharacter = async () =>
          profiles.getCharacter(key, requestSignal);
        const character = scope
          ? await scope.time("raiderIoCharacter", loadCharacter)
          : await loadCharacter();
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
              guild: null,
              raiderIoUrl: toRaiderIoUrl(key),
              source: "submitted"
            }
          ],
          skippedSubjects: [],
          excludedSubjects: [],
          research: {
            state: "initial",
            message:
              "Linked-character research is still running; this evidence covers only the submitted character."
          },
          repositories,
          queue: options.queue,
          ...gatewaysFor(overrides, scope),
          concurrency: scopedConcurrency(scope),
          freshnessCutoff: new Date(
            Date.now() - options.config.FRESHNESS_HOURS * 60 * 60 * 1000
          ),
          signal: signal ?? new AbortController().signal,
          wclCredentials: overrides?.wclCredentials,
          encryptionKey: options.evidenceJobCredentialEncryptionKey
        })
      };
    },

    async read(key, signal, overrides, scope) {
      const repositories = scopedRepositories(scope);
      const snapshot =
        (await repositories.snapshots.getCurrent(key)) ??
        (await repositories.snapshots.getCurrentContainingCharacter?.(key));
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
      const excluded: RankedSubject[] = [];
      for (const character of await repositories.manualConnections.list(
        snapshot.rootKey
      )) {
        const admit = (candidate: RankedSubject, into = manual) => {
          const id = canonicalCharacterId(candidate.key);
          if (seen.has(id)) return;
          seen.add(id);
          into.push(candidate);
        };
        // An undiscovered character has no snapshot to merge yet. Its own run
        // is still queued, and the next read picks the characters up.
        const connectedSnapshot = character.pending
          ? null
          : await repositories.snapshots.getCurrent(character.key);
        // A manual connection carries no guild of its own, and `seen` keeps its
        // row from being replaced by the one its own discovery wrote. Read the
        // guild across before admitting, or a manually added character would
        // show none however much is known about it.
        const connectedGuild =
          connectedSnapshot?.characters.find(
            (discovered) =>
              canonicalCharacterId(discovered.key) ===
              canonicalCharacterId(character.key)
          )?.guild ?? null;
        // An excluded character joins the list and nothing else, so the
        // exclusion can be reversed from the same row. Its own discoveries
        // still follow: excluding one character is not undoing the add, and
        // those characters stand on their own evidence.
        admit(
          { ...character, guild: connectedGuild, source: "manually_added" },
          character.excluded ? excluded : manual
        );
        if (character.pending) continue;
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
      // Excluded characters are ranked among themselves only, so one of them
      // never costs a researchable character its place under the cap.
      const excludedOrdered = [...excluded].sort(
        (left, right) =>
          right.level - left.level ||
          left.key.region.localeCompare(right.key.region, "en") ||
          left.key.realm.localeCompare(right.key.realm, "en") ||
          left.key.name.localeCompare(right.key.name, "en")
      );
      return {
        kind: "ready",
        dossier: await assembleDossier({
          root: snapshot.rootKey,
          subjects: selected,
          skippedSubjects: skipped,
          excludedSubjects: excludedOrdered,
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
          repositories,
          queue: options.queue,
          ...gatewaysFor(overrides, scope),
          concurrency: scopedConcurrency(scope),
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
