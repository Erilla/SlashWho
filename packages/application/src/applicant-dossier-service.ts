import {
  applicantDossierSchema,
  type ApplicantDossier as ContractApplicantDossier,
  type CollectionPhase,
  type DossierLimitation as ContractDossierLimitation
} from "@slashwho/contracts";
import type {
  DiscoveryQueue,
  EvidenceRunPhase,
  Repositories,
  StoredCharacterMythicKill,
  StoredCharacterMythicWipe,
  StoredCharacterTierBestParse,
  StoredSnapshot,
  StoredSnapshotCharacter
} from "@slashwho/database";
import {
  buildApplicantDossier,
  formatCharacterDisplayName,
  canonicalCharacterId,
  lookupCuttingEdgeAchievement,
  isAccountWideCuttingEdgeAchievement,
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
  RaiderIoGateway,
  MythicBossRankingsOptions,
  MythicBossRankingsResult
} from "@slashwho/raiderio";

import type { ApplicationConfig } from "./config";
import { createBoundedCache, type BoundedCacheOutcome } from "./bounded-cache";
import { encryptCredential } from "./credential-encryption";
import {
  collectionProgress,
  contractLimitationCode
} from "./collection-progress";
import { fullEvidencePhasePlan } from "./evidence-phase-ledger";
import {
  historicWorldRankForKill,
  raiderIoRankingRequest,
  rankingRequestKey
} from "./historic-world-rank";
import {
  refreshCharacter,
  type RefreshCharacterResult
} from "./refresh-character";
import {
  searchDossierTier,
  type SearchDossierTierResult
} from "./search-dossier-tier";
import { groupBySharedWarcraftLogsId } from "./shared-warcraft-logs-identity";
import {
  TIER_SEARCH_SPACING_MS,
  tierSearchStates,
  type TierSearchSubject
} from "./tier-search";

/**
 * How long after a collection a manual refresh does the light path instead.
 * Deliberately invisible: pressing inside it still looks for a new raid night
 * rather than refusing.
 */
const REFRESH_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_LEGACY_RANK_FALLBACK_REQUESTS_PER_READ = 50;
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
  wclCredentialRef?: { accountId: string; credentialVersion: number };
}>;

type WclCredentials = Readonly<{ clientId: string; clientSecret: string }>;

export interface ApplicantDossierService {
  addHistoricAlias(
    root: CharacterKey,
    character: CharacterKey,
    alias: CharacterKey,
    scope?: MeasurementScope
  ): Promise<"added" | "duplicate" | "self" | "missing">;
  removeHistoricAlias(
    root: CharacterKey,
    character: CharacterKey,
    alias: CharacterKey,
    scope?: MeasurementScope
  ): Promise<"removed" | "missing">;
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
    scope?: MeasurementScope,
    overrides?: DossierGatewayOverrides
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
  /**
   * Queues one explicit search of a tier (#435), keyed by the Journal raid id
   * the dossier shows it under, for every included character of the dossier
   * (#449): each keeps its own reservation, cap, cooldown and run.
   */
  searchTier(
    key: CharacterKey,
    raidId: string,
    scope?: MeasurementScope,
    overrides?: DossierGatewayOverrides
  ): Promise<SearchDossierTierResult>;
  /** Backend-only progress projection for the dossier and operator monitor. */
  readEvidencePhases?(runId: string): Promise<readonly EvidenceRunPhase[]>;
}

type EvidenceSource = "raiderio" | "warcraft_logs" | "blizzard";
type DossierSubject = Readonly<{
  key: CharacterKey;
  displayName: string;
  className: string | null;
  guild: CharacterGuild | null;
  raiderIoUrl: string;
  source: StoredSnapshotCharacter["source"] | "submitted" | "manually_added";
  /**
   * Other dossier keys that resolved to this character's Warcraft Logs ID, so
   * are the same character under another name (#423). Each keeps its own
   * collection; the evidence is shown under this subject.
   */
  warcraftLogsAliases?: readonly CharacterKey[];
}>;
type DossierEvidenceState = "waiting" | "scanning" | "complete" | "partial";
type StoredRankKillEvidence = DossierKillEvidence &
  Readonly<{
    rankLookup: { killId: string; checkedAt: string | null };
  }>;
class RankingLookupFailure extends Error {
  constructor(
    readonly result: Extract<MythicBossRankingsResult, { kind: "limitation" }>
  ) {
    super("rankings_unavailable");
  }
}
type EvidenceResult = Readonly<{
  kills: readonly StoredRankKillEvidence[];
  wipes: readonly DossierWipeEvidence[];
  tierBests: readonly DossierTierBestParse[];
  cuttingEdges: readonly DossierCuttingEdgeEvidence[] | null;
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
    case "invalid_fight_timestamp":
      return `${label} fights with impossible timestamps were omitted. Those fights cannot be shown as kills or wipes and will not be retried.`;
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
): StoredRankKillEvidence {
  return {
    raidId: kill.raidId,
    raidName: kill.raidName,
    bossId: kill.bossId,
    bossName: kill.bossName,
    journalBossId: kill.journalBossId,
    bossOrder: kill.bossOrder,
    character,
    killedAt: kill.killedAt,
    guild: kill.guild ? { ...kill.guild, region: character.region } : null,
    uploader: kill.uploader ?? null,
    historicWorldRank: kill.historicWorldRank ?? null,
    rankLookup: {
      killId: kill.id,
      checkedAt: kill.historicRankCheckedAt ?? null
    },
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
    reportUrl: wipe.fightUrl,
    guild: wipe.guild ? { ...wipe.guild, region: character.region } : null,
    uploader: wipe.uploader ?? null
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
    wclCredentialRef?: { accountId: string; credentialVersion: number };
    encryptionKey: Buffer;
    /** The subject the evidence is shown under, when not `character` itself. */
    attributeTo?: CharacterKey;
  }
): Promise<
  EvidenceResult & {
    gathering: boolean;
    collectionProgress: readonly CollectionPhase[];
  }
> {
  const attributed = options.attributeTo ?? character.key;
  const reservation = await options.repositories.evidence.reserve({
    key: character.key,
    freshnessCutoff: options.freshnessCutoff,
    at: new Date(),
    credentials:
      options.wclCredentialRef ??
      (options.wclCredentials
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
        : null),
    phasePlan: fullEvidencePhasePlan()
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
  // The same run `gathering` below is keyed on, so the steps describe exactly
  // the collection the row's spinner reports.
  const activeRun = reservation.active;
  if (completed?.run.limitationCode) {
    limitations.push(
      limitation(
        "warcraft_logs",
        attributed,
        completed.run.limitationCode,
        completed.run.completedAt ?? new Date(),
        completed.run.retryAfterAt
      )
    );
  }
  if (completed?.run.omittedInvalidTimestamp) {
    limitations.push(
      limitation(
        "warcraft_logs",
        attributed,
        "invalid_fight_timestamp",
        completed.run.completedAt ?? new Date()
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
        attributed,
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
        attributed,
        completed.run.parseLimitationCode,
        completed.run.completedAt ?? new Date(),
        completed.run.retryAfterAt
      )
    );
  }
  return {
    limitations,
    collectedAt: completed?.run.completedAt ?? null,
    kills: completed?.kills.map((kill) => cachedKill(kill, attributed)) ?? [],
    wipes: completed?.wipes.map((wipe) => cachedWipe(wipe, attributed)) ?? [],
    tierBests:
      completed?.tierBests.map((tierBest) =>
        cachedTierBest(tierBest, attributed)
      ) ?? [],
    cuttingEdges: completed?.cuttingEdgesCollected
      ? completed.cuttingEdges
      : null,
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
    collectionProgress: activeRun
      ? collectionProgress(
          (await options.repositories.evidence.listPhases?.(activeRun.id)) ?? []
        )
      : [],
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

const EVIDENCE_STATE_SEVERITY: Readonly<Record<DossierEvidenceState, number>> =
  { complete: 0, partial: 1, scanning: 2, waiting: 3 };

function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string | null) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (key === null) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One subject's evidence from the collections of every key it is known by
 * (#423), already attributed to the subject. The first result is the
 * subject's own. A fight both names were read from counts once, a shortfall
 * on any collection holds the subject back from negative conclusions, and the
 * least settled state is the one shown.
 */
type IdentityEvidence = EvidenceResult & {
  gathering: boolean;
  collectionProgress: readonly CollectionPhase[];
};

function mergeIdentityEvidence(
  results: readonly IdentityEvidence[]
): IdentityEvidence {
  const [own, ...others] = results;
  if (!own) throw new Error("identity_evidence_missing");
  if (others.length === 0) return own;
  const collected = results.flatMap((item) =>
    item.collectedAt ? [item.collectedAt.getTime()] : []
  );
  return {
    kills: uniqueBy(
      results.flatMap((item) => item.kills),
      (kill) =>
        kill.reportUrl === null ? null : `${kill.bossId}\0${kill.reportUrl}`
    ),
    wipes: uniqueBy(
      results.flatMap((item) => item.wipes),
      (wipe) => `${wipe.bossId}\0${wipe.reportUrl}`
    ),
    tierBests: results.flatMap((item) => item.tierBests),
    cuttingEdges: own.cuttingEdges,
    warcraftLogsComplete: results.every((item) => item.warcraftLogsComplete),
    limitations: uniqueBy(
      results.flatMap((item) => item.limitations),
      (item) => `${item.source}\0${item.code}`
    ),
    evidenceState: results.reduce(
      (state, item) =>
        EVIDENCE_STATE_SEVERITY[item.evidenceState] >
        EVIDENCE_STATE_SEVERITY[state]
          ? item.evidenceState
          : state,
      own.evidenceState
    ),
    collectedAt:
      collected.length === 0 ? null : new Date(Math.min(...collected)),
    gathering: results.some((item) => item.gathering),
    // One row shows one collection's steps: the subject's own while it runs,
    // otherwise whichever other name is still collecting.
    collectionProgress:
      results.find((item) => item.gathering)?.collectionProgress ?? []
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
    stored: readonly (readonly DossierCuttingEdgeEvidence[] | null)[];
    concurrency: ReturnType<typeof createConcurrencyLimiter>;
    signal?: AbortSignal;
  }
): Promise<CuttingEdgeEvidenceResult> {
  // Never throws: an abort is returned as an outcome so a concurrent batch
  // can be settled in full before it is rethrown. A bare rethrow would leave
  // this subject's siblings in flight and their rejections unhandled.
  async function read(
    character: DossierSubject,
    index: number
  ): Promise<CuttingEdgeOutcome> {
    try {
      const achievements =
        options.stored[index] ??
        (await options.concurrency.run(() =>
          options.blizzard.getCompletedAchievements(
            character.key,
            options.signal
          )
        ));
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
      outcomes[index] = await read(subjects[index]!, index);
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
    const outcome = await read(subjects[index]!, index);
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

async function restoreMissingHistoricRanks(options: {
  kills: readonly StoredRankKillEvidence[];
  raiderio: Pick<RaiderIoGateway, "getMythicBossRankings">;
  recordLookup: Repositories["evidence"]["recordHistoricRankLookup"];
  concurrency: ReturnType<typeof createConcurrencyLimiter>;
  signal: AbortSignal;
}): Promise<{
  kills: readonly StoredRankKillEvidence[];
  limitations: DossierLimitation[];
}> {
  const requests = new Map<
    string,
    NonNullable<ReturnType<typeof raiderIoRankingRequest>>
  >();
  let capped = false;
  for (const kill of options.kills) {
    if (kill.historicWorldRank !== null || kill.rankLookup.checkedAt) continue;
    const request = raiderIoRankingRequest(kill, kill.character.region);
    if (!request) continue;
    const key = rankingRequestKey(request);
    if (requests.has(key)) continue;
    if (requests.size >= MAX_LEGACY_RANK_FALLBACK_REQUESTS_PER_READ) {
      capped = true;
      continue;
    }
    requests.set(key, request);
  }
  const rankings = new Map<
    string,
    Awaited<ReturnType<RaiderIoGateway["getMythicBossRankings"]>>
  >();
  await Promise.all(
    [...requests].map(async ([key, request]) => {
      const result = await options.concurrency
        .run(() =>
          options.raiderio.getMythicBossRankings(request, options.signal)
        )
        .catch((error: unknown) => {
          if (isAbort(error, options.signal)) throw error;
          return { kind: "limitation" as const, code: "unavailable" as const };
        });
      rankings.set(key, result);
    })
  );
  const limitations: DossierLimitation[] = [];
  if (capped) {
    limitations.push({
      source: "raiderio",
      character: null,
      code: "request_cap",
      observedAt: new Date().toISOString()
    });
  }
  for (const result of rankings.values()) {
    if (result.kind === "rankings") continue;
    if (limitations.some((item) => item.code === result.code)) continue;
    limitations.push({
      source: "raiderio",
      character: null,
      code: result.code,
      observedAt: result.observedAt ?? new Date().toISOString(),
      ...(result.retryAfterMs === undefined
        ? {}
        : {
            retryAt: new Date(
              Date.parse(result.observedAt ?? new Date().toISOString()) +
                Math.max(0, result.retryAfterMs)
            ).toISOString()
          })
    });
  }
  const checkedAt = new Date();
  await Promise.all(
    options.kills.map(async (kill) => {
      if (kill.historicWorldRank !== null || kill.rankLookup.checkedAt) return;
      const request = raiderIoRankingRequest(kill, kill.character.region);
      const result = request
        ? rankings.get(rankingRequestKey(request))
        : undefined;
      if (result?.kind !== "rankings") return;
      const rank = historicWorldRankForKill(
        kill,
        kill.character.region,
        result.rows
      );
      // The dossier remains readable if a legacy write-through fails. The
      // fallback will retry on a later read instead of claiming it was stored.
      await options
        .recordLookup(kill.rankLookup.killId, rank, checkedAt)
        .catch(() => undefined);
    })
  );
  return {
    kills: options.kills.map((kill) => {
      if (kill.historicWorldRank !== null || kill.rankLookup.checkedAt)
        return kill;
      const request = raiderIoRankingRequest(kill, kill.character.region);
      const result = request
        ? rankings.get(rankingRequestKey(request))
        : undefined;
      return result?.kind === "rankings"
        ? {
            ...kill,
            historicWorldRank: historicWorldRankForKill(
              kill,
              kill.character.region,
              result.rows
            )
          }
        : kill;
    }),
    limitations
  };
}

function serializeDossierSubject(
  character: DossierSubject,
  evidence?: {
    evidenceState: DossierEvidenceState;
    gathering: boolean;
    collectionProgress?: readonly CollectionPhase[];
  },
  excluded = false,
  historicAliases: readonly CharacterKey[] = []
) {
  return {
    key: character.key,
    displayName: formatCharacterDisplayName(character.displayName),
    className: character.className,
    guild: character.guild,
    raiderIoUrl: character.raiderIoUrl,
    ...(historicAliases.length > 0 ? { historicAliases } : {}),
    ...(character.warcraftLogsAliases?.length
      ? { warcraftLogsAliases: character.warcraftLogsAliases }
      : {}),
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
            : ("complete" as const),
          ...(evidence.gathering && evidence.collectionProgress?.length
            ? { collectionProgress: [...evidence.collectionProgress] }
            : {})
        }
      : {})
  };
}

/** The submitted character alone, before any snapshot names its connections. */
function rootOnlySubject(key: CharacterKey): DossierSubject {
  return {
    key,
    displayName: key.name,
    className: null,
    guild: null,
    raiderIoUrl: toRaiderIoUrl(key),
    source: "submitted"
  };
}

/** Included dossier characters, as a tier search names and reads them. */
function tierSearchSubjects(
  subjects: readonly DossierSubject[]
): readonly TierSearchSubject[] {
  return subjects.map((subject) => ({
    key: subject.key,
    displayName: formatCharacterDisplayName(subject.displayName),
    ...(subject.warcraftLogsAliases?.length
      ? { aliases: subject.warcraftLogsAliases }
      : {})
  }));
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
  /** The roster is unknown and only durable evidence for the submitted root is shown. */
  rootOnlyStoredEvidence?: boolean;
  repositories: Pick<Repositories, "evidence">;
  queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
  blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
  raiderio: Pick<RaiderIoGateway, "getMythicBossRankings">;
  concurrency: ReturnType<typeof createConcurrencyLimiter>;

  freshnessCutoff: Date;
  signal: AbortSignal;
  wclCredentials?: WclCredentials | null;
  wclCredentialRef?: { accountId: string; credentialVersion: number };
  encryptionKey: Buffer;
}): Promise<ContractApplicantDossier> {
  const evidence = await Promise.all(
    options.subjects.map(async (character) =>
      mergeIdentityEvidence(
        await Promise.all(
          [character.key, ...(character.warcraftLogsAliases ?? [])].map((key) =>
            gatherCharacterEvidence(
              { ...character, key },
              {
                repositories: options.repositories,
                queue: options.queue,
                freshnessCutoff: options.freshnessCutoff,
                signal: options.signal,
                wclCredentials: options.wclCredentials,
                wclCredentialRef: options.wclCredentialRef,
                encryptionKey: options.encryptionKey,
                attributeTo: character.key
              }
            )
          )
        )
      )
    )
  );
  const aliases = await Promise.all(
    [...options.subjects, ...options.excludedSubjects].map(
      (character) =>
        options.repositories.evidence.historicAliases?.(character.key) ?? []
    )
  );
  const [cuttingEdgeEvidence, ranked] = await Promise.all([
    gatherCuttingEdgeEvidence(options.subjects, {
      blizzard: options.blizzard,
      stored: evidence.map((item) => item.cuttingEdges),
      concurrency: options.concurrency,
      signal: options.signal
    }),
    restoreMissingHistoricRanks({
      kills: evidence.flatMap((item) => item.kills),
      raiderio: options.raiderio,
      recordLookup: options.repositories.evidence.recordHistoricRankLookup,
      concurrency: options.concurrency,
      signal: options.signal
    })
  ]);
  const limitations = [
    ...evidence.flatMap((item) => item.limitations),
    ...cuttingEdgeEvidence.limitations,
    ...ranked.limitations,
    ...options.skippedSubjects.map((character) =>
      limitation("warcraft_logs", character.key, "request_cap", new Date())
    )
  ];
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
    limitations
  });
  // The oldest of the characters' collections, so the value reads as
  // "everything is at least this fresh" rather than tracking whichever
  // character happened to collect most recently.
  const collectedTimes = evidence.flatMap((item) =>
    item.collectedAt ? [item.collectedAt.getTime()] : []
  );
  // A tier is searched for every included character (#449), including any
  // the display cap skipped, so each one's search is shown. A failure to read
  // them costs the button its state, never the dossier.
  const searchedAt = new Date();
  const searchSubjects = tierSearchSubjects([
    ...options.subjects,
    ...options.skippedSubjects
  ]);
  // A character with nothing collected cannot be searched, so it is never
  // offered as remaining. Searches reserve under the name shown, so that is
  // the name checked; a failed read leaves every character searchable.
  const withEvidence = await Promise.resolve()
    .then(() =>
      options.repositories.evidence.withCompletedEvidence?.(
        searchSubjects.map((subject) => subject.key)
      )
    )
    .then((keys) =>
      keys ? new Set(keys.map(canonicalCharacterId)) : undefined
    )
    .catch(() => undefined);
  const tierSearches = tierSearchStates(
    searchSubjects,
    await Promise.resolve()
      .then(() =>
        options.repositories.evidence.latestTierSearches(
          searchSubjects.flatMap((subject) => [
            subject.key,
            ...(subject.aliases ?? [])
          ]),
          new Date(searchedAt.getTime() - TIER_SEARCH_SPACING_MS)
        )
      )
      .catch(() => []),
    searchedAt,
    withEvidence
  );
  return applicantDossierSchema.parse({
    ...dossier,
    raids: dossier.raids.map((raid) => {
      const tierSearch = tierSearches.get(raid.raidId);
      return tierSearch ? { ...raid, tierSearch } : raid;
    }),
    lastCollectedAt:
      collectedTimes.length === 0
        ? null
        : new Date(Math.min(...collectedTimes)).toISOString(),
    // A provisional list is the page's cue to research the character itself,
    // so evidence still gathering beneath it must not replace that state.
    research:
      options.research.state !== "provisional" &&
      evidence.some((item) => item.gathering)
        ? options.rootOnlyStoredEvidence
          ? {
              state: "gathering" as const,
              message:
                "Linked-character research is pending, and historic mythic evidence is still gathering. Cached results for only the submitted character are shown."
            }
          : {
              state: "gathering" as const,
              message:
                "Historic mythic evidence is still gathering in the background. Cached results are shown while it completes."
            }
        : options.research,
    characters: [
      ...options.subjects.map((character, index) =>
        serializeDossierSubject(
          character,
          evidence[index],
          false,
          aliases[index]
        )
      ),
      // Excluded rows sit after the researched ones rather than holding their
      // ranked position, so the list reads top-down as evidence then exclusions.
      ...options.excludedSubjects.map((character, index) =>
        serializeDossierSubject(
          character,
          undefined,
          true,
          aliases[options.subjects.length + index]
        )
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

// Sized for the achievement lookups made by one cold dossier and the number
// of distinct rosters that should fit inside the TTL window without eviction.
const DOSSIER_CACHE_TTL_MS = 15 * 60_000;
const ACHIEVEMENT_KEYS_PER_DOSSIER = 10;
// The multiple is the number of concurrent cold reads of distinct rosters that
// fit inside the 15-minute window before entries start evicting each other.
//
// Replicas are not what this covers. Each `web` replica holds its own
// process-local cache, so replication splits traffic across instances rather
// than crowding one -- it costs hit rate, because every replica cold-loads the
// same keys independently, not capacity per instance.
//
// This also sets the cache's in-flight ceiling, since `createBoundedCache`
// rejects a load once `pending.size` reaches `maxEntries`. That is a far
// backstop at these sizes rather than the operative limit: achievement loads
// are admitted by `providerConcurrency` and gathered one character at a time.
// Parallelising that gather (#241) raises the cache's in-flight count per read
// and should re-check this.
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

export function createApplicantDossierService(options: {
  repositories: Pick<
    Repositories,
    "snapshots" | "evidence" | "manualConnections"
  >;
  queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
  search: Pick<SearchService, "create" | "scheduleConnectedCharacterSweep">;
  blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
  raiderio: Pick<RaiderIoGateway, "getCharacter" | "getMythicBossRankings">;
  config: ApplicationConfig;
  evidenceJobCredentialEncryptionKey: Buffer;
  onCacheEvent?: (source: string, event: string) => void;
  logger?: { info(value: Record<string, unknown>): void };
}): ApplicantDossierService {
  const achievements = createBoundedCache<
    Awaited<ReturnType<BlizzardGateway["getCompletedAchievements"]>>
  >({
    ttlMs: DOSSIER_CACHE_TTL_MS,
    maxEntries: ACHIEVEMENT_KEYS_PER_DOSSIER * CONCURRENT_COLD_DOSSIERS,
    observe: (event) => options.onCacheEvent?.("blizzard_cutting_edge", event)
  });
  const rankings = createBoundedCache<
    Awaited<ReturnType<RaiderIoGateway["getMythicBossRankings"]>>
  >({
    ttlMs: DOSSIER_CACHE_TTL_MS,
    maxEntries: 25 * CONCURRENT_COLD_DOSSIERS,
    negativeTtlMs: options.config.NEGATIVE_CACHE_TTL_MS,
    cacheFailure: (error) =>
      error instanceof RankingLookupFailure &&
      error.result.code === "unavailable",
    observe: (event) => options.onCacheEvent?.("raiderio_rankings", event)
  });
  // The limiter instance is shared across every request so it actually
  // bounds the fan-out; only the wait *reporting* is per-call, via a
  // scope-bound facade built per readInitial/read call below.
  const providerConcurrency = createConcurrencyLimiter(
    options.config.DOSSIER_PROVIDER_CONCURRENCY
  );
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
  async function isConnectedToDossier(
    repositories: typeof options.repositories,
    root: CharacterKey,
    target: CharacterKey
  ): Promise<boolean> {
    const wanted = canonicalCharacterId(target);
    if (wanted === canonicalCharacterId(root)) return true;
    const snapshot = await repositories.snapshots.getCurrent(root);
    if (
      snapshot?.characters.some(
        (item) => canonicalCharacterId(item.key) === wanted
      )
    )
      return true;
    for (const connection of await repositories.manualConnections.list(root)) {
      if (canonicalCharacterId(connection.key) === wanted) return true;
      if (connection.pending) continue;
      const discovered = await repositories.snapshots.getCurrent(
        connection.key
      );
      if (
        discovered?.characters.some(
          (item) => canonicalCharacterId(item.key) === wanted
        )
      )
        return true;
    }
    return false;
  }
  /**
   * The other keys of this dossier that share the target's recorded Warcraft
   * Logs ID, so are shown on the target's row (#423). The root is left out: a
   * dossier cannot exclude the character it is about. Empty when the target
   * has no recorded ID or the store cannot read IDs.
   */
  async function sharedIdentityKeys(
    repositories: typeof options.repositories,
    root: CharacterKey,
    target: CharacterKey
  ): Promise<readonly CharacterKey[]> {
    if (!repositories.evidence.warcraftLogsCharacterIds) return [];
    const snapshot = await repositories.snapshots.getCurrent(root);
    const keys = [...(snapshot?.characters.map((item) => item.key) ?? [])];
    for (const connection of await repositories.manualConnections.list(root)) {
      keys.push(connection.key);
      if (connection.pending) continue;
      const discovered = await repositories.snapshots.getCurrent(
        connection.key
      );
      keys.push(...(discovered?.characters.map((item) => item.key) ?? []));
    }
    const recorded = await repositories.evidence.warcraftLogsCharacterIds([
      target,
      ...keys
    ]);
    const idOf = (key: CharacterKey) =>
      recorded.find(
        (entry) => canonicalCharacterId(entry.key) === canonicalCharacterId(key)
      )?.characterId;
    const targetId = idOf(target);
    if (targetId === undefined) return [];
    const excludedIds = new Set([
      canonicalCharacterId(root),
      canonicalCharacterId(target)
    ]);
    return keys.filter((key) => {
      const id = canonicalCharacterId(key);
      if (excludedIds.has(id) || idOf(key) !== targetId) return false;
      excludedIds.add(id);
      return true;
    });
  }
  async function queueHistoricAliasRecollection(
    character: CharacterKey,
    scope?: MeasurementScope
  ): Promise<void> {
    try {
      await refreshCharacter({
        key: character,
        at: new Date(),
        cooldownMs: 0,
        repositories: options.repositories,
        queue: options.queue,
        ...(scope ? { scope } : {})
      });
    } catch {
      // The alias edit stored a durable recollection request. The resume
      // sweep will enqueue it if the immediate dispatch could not finish.
      options.logger?.info({ event: "historic_alias_enqueue_deferred" });
    }
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
  // New ranks are durable worker evidence. A legacy rankless kill gets one
  // successful read fallback, then its answer (including no match) is stored.
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
      raiderio: {
        getMythicBossRankings: async (
          request: MythicBossRankingsOptions,
          signal?: AbortSignal
        ) => {
          signal?.throwIfAborted();
          const load = async (): Promise<MythicBossRankingsResult> => {
            const call = () =>
              overrides?.raiderio
                ? overrides.raiderio.getMythicBossRankings(request, signal)
                : options.raiderio.getMythicBossRankings(
                    request,
                    AbortSignal.timeout(15_000),
                    () => scope?.increment("raiderIoRankingPhysicalCalls")
                  );
            const result = scope
              ? await scope.time("raiderIoRankings", call)
              : await call();
            if (result.kind === "limitation") {
              options.onCacheEvent?.(
                "raiderio_rankings",
                `failure_${result.code}`
              );
              throw new RankingLookupFailure({
                ...result,
                observedAt: result.observedAt ?? new Date().toISOString()
              });
            }
            return result;
          };
          try {
            return await awaitWithAbort(
              overrides?.raiderio
                ? load()
                : rankings(
                    rankingRequestKey(request),
                    load,
                    cacheObserver(scope)
                  ),
              signal
            );
          } catch (error) {
            signal?.throwIfAborted();
            return error instanceof RankingLookupFailure
              ? error.result
              : {
                  kind: "limitation" as const,
                  code: "unavailable" as const,
                  observedAt: new Date().toISOString()
                };
          }
        }
      }
    };
  }
  /**
   * Another root's snapshot, re-rooted at a character it lists as a
   * Raider.IO-declared member, so a character with no discovery of its own
   * shows the account it was claimed on while that discovery runs. An
   * inferred membership is not enough to put another root's whole list under
   * this character's name. Nothing is stored: the view lasts one read, and
   * the character's own snapshot replaces it once published.
   */
  function borrowSnapshot(
    key: CharacterKey,
    containing: StoredSnapshot | null | undefined
  ): StoredSnapshot | null {
    if (!containing) return null;
    const id = canonicalCharacterId(key);
    const member = containing.characters.find(
      (character) => canonicalCharacterId(character.key) === id
    );
    if (member?.source !== "claimed" && member?.source !== "declared_main")
      return null;
    const formerRootId = canonicalCharacterId(containing.rootKey);
    return {
      ...containing,
      rootKey: key,
      characters: containing.characters.map((character) => {
        const characterId = canonicalCharacterId(character.key);
        if (characterId === id) return { ...character, source: "input" };
        if (characterId === formerRootId)
          return { ...character, source: "claimed" };
        return character;
      })
    };
  }

  /**
   * The dossier's characters: each included identity in ranked order, split
   * at the display cap into `selected` and `skipped`, and the excluded ones.
   * Null when no snapshot contains the character yet. Reading and searching a
   * tier both go through here, so they can never disagree about who is in
   * the dossier.
   */
  async function resolveSubjects(
    key: CharacterKey,
    repositories: ReturnType<typeof scopedRepositories>
  ) {
    const own = await repositories.snapshots.getCurrent(key);
    const snapshot =
      own ??
      borrowSnapshot(
        key,
        await repositories.snapshots.getCurrentContainingCharacter?.(key)
      );
    if (!snapshot) return null;
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
    const manualExcludedIds = new Set<string>();
    for (const character of await repositories.manualConnections.list(
      snapshot.rootKey
    )) {
      if (character.excluded) {
        manualExcludedIds.add(canonicalCharacterId(character.key));
      }
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
    const discoveredExclusions = new Set(
      (
        (await repositories.manualConnections.listDiscoveredExclusions?.(
          snapshot.rootKey
        )) ?? []
      ).map(canonicalCharacterId)
    );
    for (const id of manualExcludedIds) discoveredExclusions.add(id);
    const isExcluded = (character: RankedSubject) =>
      discoveredExclusions.has(canonicalCharacterId(character.key));
    const isRoot = (character: RankedSubject) =>
      canonicalCharacterId(character.key) === rootId;
    const ordered = [...snapshot.characters, ...manual].sort((left, right) => {
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
    // Keys that resolved to one Warcraft Logs ID are one character under
    // several names (#423), so they share one row and one cap slot. A failed
    // read costs only the merge: every key is then listed on its own, as it
    // was before the IDs were known.
    const candidates = [...ordered, ...excluded];
    const recordedIds = await Promise.resolve()
      .then(
        () =>
          repositories.evidence.warcraftLogsCharacterIds?.(
            candidates.map((character) => character.key)
          ) ?? []
      )
      .catch(() => []);
    const identities = groupBySharedWarcraftLogsId(
      candidates,
      recordedIds,
      // The searched character is never renamed out from under its own
      // dossier. Otherwise an excluded key leads an excluded identity, so
      // the row's Include reverses the exclusion that hides it.
      (members) =>
        members.find(isRoot) ?? members.find(isExcluded) ?? members[0]!
    ).map(({ primary, aliases }) => ({
      subject:
        aliases.length === 0
          ? primary
          : {
              ...primary,
              warcraftLogsAliases: aliases.map((alias) => alias.key)
            },
      // An exclusion on any of the names hides the character they share,
      // except the searched character, which a dossier cannot exclude.
      excluded: !isRoot(primary) && [primary, ...aliases].some(isExcluded)
    }));
    const includedOrdered = identities.flatMap((identity) =>
      identity.excluded ? [] : [identity.subject]
    );
    const excludedIdentities = identities.flatMap((identity) =>
      identity.excluded ? [identity.subject] : []
    );
    const selected = includedOrdered.slice(
      0,
      options.config.DOSSIER_CHARACTER_CAP
    );
    const skipped = includedOrdered.slice(selected.length);
    // Excluded characters are ranked among themselves only, so one of them
    // never costs a researchable character its place under the cap.
    const excludedOrdered = [...excludedIdentities].sort(
      (left, right) =>
        right.level - left.level ||
        left.key.region.localeCompare(right.key.region, "en") ||
        left.key.realm.localeCompare(right.key.realm, "en") ||
        left.key.name.localeCompare(right.key.name, "en")
    );
    return {
      snapshot,
      selected,
      skipped,
      excludedOrdered,
      provisional: own === null
    };
  }

  async function readRootOnly(
    key: CharacterKey,
    hasStoredEvidence: boolean,
    repositories: ReturnType<typeof scopedRepositories>,
    signal?: AbortSignal,
    overrides?: DossierGatewayOverrides,
    scope?: MeasurementScope
  ): Promise<ReadDossierResult> {
    return {
      kind: "ready",
      dossier: await assembleDossier({
        root: key,
        subjects: [rootOnlySubject(key)],
        skippedSubjects: [],
        excludedSubjects: [],
        research: {
          state: "initial",
          message: hasStoredEvidence
            ? "Linked-character research is pending; stored evidence is shown only for the submitted character."
            : "Linked-character research is still running; this evidence covers only the submitted character."
        },
        rootOnlyStoredEvidence: hasStoredEvidence,
        repositories,
        queue: options.queue,
        ...gatewaysFor(overrides, scope),
        concurrency: scopedConcurrency(scope),
        freshnessCutoff: new Date(
          Date.now() - options.config.FRESHNESS_HOURS * 60 * 60 * 1000
        ),
        signal: signal ?? new AbortController().signal,
        wclCredentials: overrides?.wclCredentials,
        wclCredentialRef: overrides?.wclCredentialRef,
        encryptionKey: options.evidenceJobCredentialEncryptionKey
      })
    };
  }
  return {
    async addHistoricAlias(root, character, alias, scope) {
      const repositories = scopedRepositories(scope);
      if (canonicalCharacterId(character) === canonicalCharacterId(alias))
        return "self";
      if (character.region !== alias.region) return "missing";
      if (!(await isConnectedToDossier(repositories, root, character)))
        return "missing";
      const result = await repositories.evidence.addHistoricAlias?.(
        character,
        alias
      );
      if (result !== "added") return result ?? "missing";
      await queueHistoricAliasRecollection(character, scope);
      return "added";
    },
    async removeHistoricAlias(root, character, alias, scope) {
      const repositories = scopedRepositories(scope);
      if (!(await isConnectedToDossier(repositories, root, character)))
        return "missing";
      const result = await repositories.evidence.removeHistoricAlias?.(
        character,
        alias
      );
      if (result !== "removed") return "missing";
      await queueHistoricAliasRecollection(character, scope);
      return "removed";
    },
    async readEvidencePhases(runId) {
      return options.repositories.evidence.listPhases?.(runId) ?? [];
    },
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
      const repositories = scopedRepositories(scope);
      const exclude = async (key: CharacterKey) => {
        const result = await repositories.manualConnections.setExcluded(
          root,
          key,
          input.excluded
        );
        if (result === "updated") return true;
        if (!(await isConnectedToDossier(repositories, root, key)))
          return false;
        const discovered =
          await repositories.manualConnections.setDiscoveredExcluded?.(
            root,
            key,
            input.excluded
          );
        return discovered === "updated";
      };
      if (!(await exclude(target))) return { kind: "missing" };
      // A merged row is hidden while any of its names is excluded, so the
      // row's action applies to every name, or Include would clear one of two
      // exclusions and leave the row as it was, with no row for the other.
      for (const key of await sharedIdentityKeys(repositories, root, target)) {
        await exclude(key);
      }
      return { kind: "updated" };
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

    async refreshCharacter(key, scope, overrides) {
      // Deliberately takes no mode. The reader-facing control is `full` outside
      // the cooldown and `light` inside it, one run either way, and there is no
      // argument a caller could pass to turn it into a rebuild.
      return refreshCharacter({
        key,
        at: new Date(),
        cooldownMs: REFRESH_COOLDOWN_MS,
        repositories: options.repositories,
        queue: options.queue,
        credentials: overrides?.wclCredentialRef,
        ...(options.logger ? { logger: options.logger } : {}),
        ...(scope ? { scope } : {})
      });
    },

    async searchTier(key, raidId, scope, overrides) {
      // The same characters the dossier researches, before its display cap:
      // a character the list has no room for still has gaps to fill.
      const resolved = await resolveSubjects(key, scopedRepositories(scope));
      const subjects = resolved
        ? [...resolved.selected, ...resolved.skipped]
        : [rootOnlySubject(key)];
      return searchDossierTier({
        subjects: tierSearchSubjects(subjects),
        raidId,
        at: new Date(),
        repositories: options.repositories,
        queue: options.queue,
        ...(overrides?.wclCredentialRef
          ? { credentials: overrides.wclCredentialRef }
          : {}),
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
      const hasStoredEvidence =
        (await repositories.evidence.getCompleted(key)) !== null;
      if (!hasStoredEvidence) {
        // Initial evidence precedes the worker's snapshot filter. Completed
        // evidence is already public dossier material; without it, one bounded
        // lookup prevents a tournament root from appearing before the current
        // discovery finishes.
        const timeout = AbortSignal.timeout(15_000);
        const requestSignal = signal
          ? AbortSignal.any([signal, timeout])
          : timeout;
        const profiles = overrides?.raiderio ?? options.raiderio;
        try {
          requestSignal.throwIfAborted();
          // The visitor's own gateway when supplied, the shared gateway
          // otherwise; either call is timed against this read's scope.
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
      }
      return readRootOnly(
        key,
        hasStoredEvidence,
        repositories,
        signal,
        overrides,
        scope
      );
    },

    async read(key, signal, overrides, scope) {
      const repositories = scopedRepositories(scope);
      const resolved = await resolveSubjects(key, repositories);
      if (!resolved) {
        // Evidence is keyed by character, not by dossier. Reuse that already
        // public material here, while the ordinary assembly path below still
        // reserves stale collection work.
        const completed = await repositories.evidence.getCompleted(key);
        if (!completed) return { kind: "not_ready" };
        return readRootOnly(key, true, repositories, signal, overrides, scope);
      }
      const { snapshot, selected, skipped, excludedOrdered, provisional } =
        resolved;

      // The existing dossier stays readable while this cadence-gated background
      // sweep checks for members who joined current or historical guilds. Its
      // dispatch must not turn a usable cached dossier into an HTTP failure.
      // Do not retain the request's measurement scope after the response ends.
      void Promise.resolve()
        .then(() => options.search.scheduleConnectedCharacterSweep?.(key))
        .catch(() => {
          options.logger?.info({ event: "fingerprint_sweep_schedule_failed" });
        });

      return {
        kind: "ready",
        dossier: await assembleDossier({
          root: snapshot.rootKey,
          subjects: selected,
          skippedSubjects: skipped,
          excludedSubjects: excludedOrdered,
          research: provisional
            ? {
                state: "provisional",
                message:
                  "Linked characters are shown from an existing dossier while this character's own research runs; the list may change."
              }
            : snapshot.state === "complete"
              ? {
                  state: "complete",
                  message: "Linked-character research is complete."
                }
              : {
                  state: "partial",
                  message:
                    snapshot.limitationCode === "privacy_hidden"
                      ? "Raider.IO shows no public account claim for this character, so additional linked characters may exist; this dossier is not exhaustive."
                      : "Additional linked characters may exist; this dossier is not exhaustive."
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
          wclCredentialRef: overrides?.wclCredentialRef,
          encryptionKey: options.evidenceJobCredentialEncryptionKey
        })
      };
    }
  };
}
