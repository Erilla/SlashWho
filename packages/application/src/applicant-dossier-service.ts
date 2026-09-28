import {
  applicantDossierSchema,
  type ApplicantDossier as ContractApplicantDossier,
  type CollectionPhase,
  type EvidenceRunProgressResponse
} from "@slashwho/contracts";
import type {
  DiscoveryQueue,
  EvidenceRunPhase,
  EvidenceRunProgress,
  RecentDossierSearch,
  Repositories,
  StoredCharacterMythicKill,
  StoredCharacterMythicWipe,
  StoredCharacterTierBestParse,
  StoredSnapshot,
  StoredSnapshotCharacter
} from "@slashwho/database";
import {
  buildApplicantDossier,
  collectGuildRaidNights,
  formatCharacterDisplayName,
  canonicalCharacterId,
  isAccountWideCuttingEdgeAchievement,
  parseApplicantCharacterUrl,
  summarizeLimitationEncounters,
  toRaiderIoUrl,
  type CharacterGuild,
  type CharacterKey,
  type DossierCuttingEdgeEvidence,
  type DossierWipeEvidence,
  type DossierTierBestParse,
  type DossierLimitation,
  type DossierRaiderIoFirstKill
} from "@slashwho/domain";
import type { BlizzardGateway } from "@slashwho/blizzard";
import type { RaiderIoGateway } from "@slashwho/raiderio";

import { isAbort } from "./abort";
import type { ApplicationConfig } from "./config";
import { encryptCredential } from "./credential-encryption";
import { collectionProgress } from "./collection-progress";
import {
  createDossierGateways,
  PROVIDER_TIMEOUT_MS,
  type DossierGatewayOverrides,
  type WclCredentials
} from "./dossier-gateways";
import {
  blizzardLimitationCode,
  contractLimitation,
  limitation,
  mergeLimitations,
  retryAfterAt
} from "./dossier-limitations";
import { fullEvidencePhasePlan } from "./evidence-phase-ledger";
import {
  restoreMissingHistoricRanks,
  type StoredRankKillEvidence
} from "./historic-ranks";
import {
  refreshCharacter,
  type RefreshCharacterResult
} from "./refresh-character";
import {
  searchDossierTier,
  type SearchDossierTierResult
} from "./search-dossier-tier";
import { dossierRaiderIoFirstKill } from "./raiderio-first-kill-evidence";
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
import type { createConcurrencyLimiter } from "./concurrency";
import { measuredRepositories } from "./measured-repositories";
import { staleReadNeedsOnlyNewestPage } from "./settled-collection";
import type { ExcludeFromBucket, MeasurementScope } from "./measurement";
import type {
  CreateSearchCommand,
  CreateSearchResult,
  SearchService
} from "./search-service";

export type { DossierGatewayOverrides } from "./dossier-gateways";

export type CreateDossierCommand = CreateSearchCommand;
export type CreateDossierResult = CreateSearchResult;
export type ReadDossierResult =
  { kind: "ready"; dossier: ContractApplicantDossier } | { kind: "not_ready" };
/**
 * The two reads that can reserve collection: `readInitial`, the root-only
 * answer while discovery runs, and an ordinary `read`.
 */
type DossierReadOrigin = "dossier_initial" | "dossier_read";
/** `missing` covers a link another reviewer has already removed. */
export type ConnectedCharacterExclusionResult =
  | { kind: "updated" }
  | { kind: "missing" }
  | { kind: "invalid"; code: "invalid_character_url" };
export type ConnectedCharacterRemovalResult =
  | { kind: "removed" }
  | { kind: "missing" }
  | { kind: "invalid"; code: "invalid_character_url" };

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
  /**
   * The characters most recently searched through `start`, one row each,
   * for the landing page.
   */
  listRecentSearches(
    limit: number,
    scope?: MeasurementScope
  ): Promise<readonly RecentDossierSearch[]>;
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
  /**
   * Where each of these evidence runs has got to, for a page watching a
   * dossier's collection (#690). One query, and none of the dossier's
   * assembly: no reservation, no provider call.
   */
  readEvidenceRunProgress(
    ids: readonly string[],
    scope?: MeasurementScope
  ): Promise<EvidenceRunProgressResponse["runs"]>;
}

/**
 * A run's progress as the page sees it. The version is the status, any
 * deferral and every step's state, so it moves exactly when a re-read of the
 * dossier would show something new: a step starting or finishing, a deferral
 * the row reports, or the run publishing. A deferred run is waiting, not
 * collecting, however its status reads.
 */
export function evidenceRunProgressView(
  progress: EvidenceRunProgress
): EvidenceRunProgressResponse["runs"][number] {
  return {
    id: progress.id,
    state: !ACTIVE_RUN_STATUSES.has(progress.status)
      ? "settled"
      : progress.status === "running" && !progress.deferred
        ? "running"
        : "queued",
    version: [
      progress.deferred ? `${progress.status}-deferred` : progress.status,
      ...progress.phaseStates
    ].join(":")
  };
}

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
type EvidenceResult = Readonly<{
  kills: readonly StoredRankKillEvidence[];
  wipes: readonly DossierWipeEvidence[];
  tierBests: readonly DossierTierBestParse[];
  raiderIoFirstKills: readonly DossierRaiderIoFirstKill[];
  cuttingEdges: readonly DossierCuttingEdgeEvidence[] | null;
  warcraftLogsComplete: boolean;
  limitations: readonly DossierLimitation[];
  evidenceState: DossierEvidenceState;
  /**
   * When a read may next collect over fresh evidence: the last run's retry
   * time, past which its evidence stops counting as fresh.
   */
  resumesAt: Date | null;
  /** When this character's evidence last finished collecting. */
  collectedAt: Date | null;
}>;
type CuttingEdgeEvidenceResult = Readonly<{
  cuttingEdges: readonly DossierCuttingEdgeEvidence[];
  limitations: readonly DossierLimitation[];
}>;

/**
 * A stored kill the dossier shows no parse for. Not "any metric unavailable":
 * every fight starts all three unavailable and only a ranking row makes one
 * available, so a DPS kill with a good damage parse still carries an
 * unavailable healing metric. Counting that would name nearly every kill.
 */
function hasNoParse(kill: StoredCharacterMythicKill): boolean {
  const { damage, healing, bossDamage } = kill.performance;
  return [damage, healing, bossDamage].every(
    (metric) => metric.state === "unavailable"
  );
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
    /** Which read this is, recorded on a run it reserves (#708). */
    origin: DossierReadOrigin;
    /** The dossier being read, recorded on a run it reserves. */
    root: CharacterKey;
    repositories: Pick<Repositories, "evidence">;
    queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
    freshnessCutoff: Date;
    signal?: AbortSignal;
    wclCredentials?: WclCredentials | null | undefined;
    wclCredentialRef?:
      { accountId: string; credentialVersion: number } | undefined;
    encryptionKey: Buffer;
    /** The subject the evidence is shown under, when not `character` itself. */
    attributeTo?: CharacterKey;
  }
): Promise<IdentityEvidence> {
  const attributed = options.attributeTo ?? character.key;
  const reservation = await options.repositories.evidence.reserve({
    key: character.key,
    origin: options.origin,
    root: options.root,
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
  let lightRunId: string | null = null;
  if (reservation.kind === "reserved") {
    // Stale evidence of a character with nothing left to collect needs only
    // the newest page, for a raid night since its last run (#540). A ranked
    // continuation is its own targeted run and keeps its mode.
    const light =
      reservation.run.mode !== "tier_search" &&
      (await staleReadNeedsOnlyNewestPage({
        key: character.key,
        at: new Date(),
        completed: reservation.completed,
        completedVersionCurrent: reservation.completedVersionCurrent ?? false,
        evidence: options.repositories.evidence
      }));
    // Recorded before the job exists, so no read of the queued run sees it as
    // a full run that supersedes the last one's notices (#541).
    if (light)
      await options.repositories.evidence.markLightRefresh(reservation.run.id);
    const queueJobId = await options.queue.enqueueCharacterEvidence(
      reservation.run.id,
      {
        enqueuedAt: new Date().toISOString(),
        ...(light ? { mode: "light" as const } : {})
      }
    );
    await options.repositories.evidence.markEnqueued(
      reservation.run.id,
      queueJobId
    );
    if (light) lightRunId = reservation.run.id;
  }
  const limitations: DossierLimitation[] = [];
  const completed = reservation.completed;
  // The same run `gathering` below is keyed on, so the steps describe exactly
  // the collection the row's spinner reports. A run this read just marked
  // light carries the mark here too.
  const activeRun =
    reservation.active && reservation.active.id === lightRunId
      ? { ...reservation.active, lightRefresh: true }
      : reservation.active;
  // What the last run fell short on is only current until the next full run
  // starts re-reading it. From then the row shows that collection and its
  // steps, and repeating the old shortfall beside it reads as today's news
  // about a read already being redone (#526). A tier search re-reads none of
  // it, and neither does a light refresh -- one page of history, bookmark
  // untouched -- so neither supersedes anything.
  const superseded =
    !!activeRun &&
    activeRun.id !== completed?.run.id &&
    activeRun.mode !== "tier_search" &&
    activeRun.lightRefresh !== true;
  const lastRun = superseded ? undefined : completed?.run;
  if (lastRun?.limitationCode) {
    limitations.push(
      limitation(
        "warcraft_logs",
        attributed,
        lastRun.limitationCode,
        lastRun.completedAt ?? new Date(),
        lastRun.retryAfterAt
      )
    );
  }
  if (lastRun?.omittedInvalidTimestamp) {
    limitations.push(
      limitation(
        "warcraft_logs",
        attributed,
        "invalid_fight_timestamp",
        lastRun.completedAt ?? new Date()
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
  if (lastRun?.parseLimitationCode) {
    // Every reason the run met, not only the one it is judged by: two
    // characters capped for different reasons read differently (#526). The
    // kills are the ones whose parses are missing, which no single reason
    // owns, so each reason names them all.
    const missingParses = summarizeLimitationEncounters(
      (completed?.kills ?? []).filter(hasNoParse)
    );
    for (const code of new Set([
      lastRun.parseLimitationCode,
      ...(lastRun.parseLimitationCodesSeen ?? [])
    ])) {
      limitations.push(
        limitation(
          "warcraft_logs",
          attributed,
          code,
          lastRun.completedAt ?? new Date(),
          lastRun.retryAfterAt,
          missingParses
        )
      );
    }
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
    raiderIoFirstKills:
      completed?.raiderIoFirstKills?.map((kill) =>
        dossierRaiderIoFirstKill(kill, attributed)
      ) ?? [],
    cuttingEdges: completed?.cuttingEdgesCollected
      ? completed.cuttingEdges
      : null,
    // Negative conclusions rest on the history scan, which `limitationCode`
    // reports. A run whose only shortfall is its parse budget, or its
    // Raider.IO logged-encounter reads (#732), scanned the whole history and
    // publishes `partial` to say so, so requiring `complete` here would
    // silently withdraw conclusions the evidence still supports. A run whose
    // scan was skipped scanned nothing, so it never supports one, whatever
    // else it names.
    warcraftLogsComplete:
      reservation.kind === "fresh" &&
      (completed?.run.status === "complete" ||
        (completed?.run.status === "partial" &&
          completed.run.killScanSkipped !== true &&
          (completed.run.parseLimitationCode !== null ||
            completed.run.raiderIoLimitationCode != null))) &&
      completed.run.limitationCode === null &&
      completed.wipeCapable,
    // Keyed on the run, not on `kind`: a refresh forces a collection past the
    // freshness window, so the read that should report "Collecting..." is
    // exactly the one whose stored evidence is still fresh. `evidenceState`
    // below stays keyed on `kind` -- fresh evidence does not become incomplete
    // because a refresh is running over it.
    gathering: reservation.active !== null,
    activeRunIds: reservation.active ? [reservation.active.id] : [],
    collectionProgress: activeRun
      ? collectionProgress(
          (await options.repositories.evidence.listPhases?.(activeRun.id)) ?? []
        )
      : [],
    // Either of two things adds to fresh evidence without a refresh: the last
    // run's own retry, and a capped tier search continuing its walk.
    resumesAt:
      reservation.kind === "fresh"
        ? earliest(
            completed?.run.retryAfterAt ?? null,
            reservation.tierSearchResumesAt ?? null
          )
        : null,
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

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "retrying"
]);

function earliest(...times: readonly (Date | null)[]): Date | null {
  return times.reduce<Date | null>(
    (soonest, time) =>
      time !== null && (soonest === null || time < soonest) ? time : soonest,
    null
  );
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
  /** The runs collecting right now, which the page watches (#690). */
  activeRunIds: readonly string[];
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
    // Every name's collection is attributed to the subject, so one first kill
    // per boss: the subject's own name first.
    raiderIoFirstKills: uniqueBy(
      results.flatMap((item) => item.raiderIoFirstKills),
      (kill) => `${kill.raidSlug}\0${kill.bossSlug}`
    ),
    cuttingEdges: own.cuttingEdges,
    warcraftLogsComplete: results.every((item) => item.warcraftLogsComplete),
    limitations: mergeLimitations(results.flatMap((item) => item.limitations)),
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
    // The soonest any name resumes: that read is the one that changes the row.
    resumesAt: earliest(...results.map((item) => item.resumesAt)),
    gathering: results.some((item) => item.gathering),
    activeRunIds: results.flatMap((item) => item.activeRunIds),
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

function serializeDossierSubject(
  character: DossierSubject,
  evidence?: {
    evidenceState: DossierEvidenceState;
    resumesAt?: Date | null;
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
          ...(evidence.resumesAt
            ? { evidenceResumesAt: evidence.resumesAt.toISOString() }
            : {}),
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
  /** Which read is assembling, recorded on any run it reserves (#708). */
  evidenceOrigin: DossierReadOrigin;
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
  wclCredentials?: WclCredentials | null | undefined;
  wclCredentialRef?:
    { accountId: string; credentialVersion: number } | undefined;
  encryptionKey: Buffer;
  /** The read's scope, which times the assembly as `assemble` (#687). */
  scope?: MeasurementScope | undefined;
}): Promise<ContractApplicantDossier> {
  const evidence = await Promise.all(
    options.subjects.map(async (character) =>
      mergeIdentityEvidence(
        await Promise.all(
          [character.key, ...(character.warcraftLogsAliases ?? [])].map((key) =>
            gatherCharacterEvidence(
              { ...character, key },
              {
                origin: options.evidenceOrigin,
                root: options.root,
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
      async (character) =>
        (await options.repositories.evidence.historicAliases?.(
          character.key
        )) ?? []
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
      recordLookup: (...args) =>
        options.repositories.evidence.recordHistoricRankLookup(...args),
      concurrency: options.concurrency,
      signal: options.signal
    })
  ]);
  // Everything from here on works on evidence already in hand, so it is timed
  // as the read's own `assemble` bucket (#687). The two database reads inside
  // are left out of it, because `db` already times them.
  const assemble = async (excluded: ExcludeFromBucket) => {
    const limitations = [
      ...evidence.flatMap((item) => item.limitations),
      ...cuttingEdgeEvidence.limitations,
      ...ranked.limitations,
      // Past the display cap nothing was requested, and nothing will be until
      // the roster changes: no retry brings these in.
      ...options.skippedSubjects.map((character) => ({
        ...limitation(
          "warcraft_logs",
          character.key,
          "request_cap",
          new Date()
        ),
        recovery: "none" as const
      }))
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
      raiderIoFirstKills: evidence.flatMap((item) => item.raiderIoFirstKills),
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
    const withEvidence = await excluded(() =>
      Promise.resolve()
        .then(() =>
          options.repositories.evidence.withCompletedEvidence?.(
            searchSubjects.map((subject) => subject.key)
          )
        )
        .then((keys) =>
          keys ? new Set(keys.map(canonicalCharacterId)) : undefined
        )
        .catch(() => undefined)
    );
    const latestTierSearches = await excluded(() =>
      Promise.resolve()
        .then(() =>
          options.repositories.evidence.latestTierSearches(
            searchSubjects.flatMap((subject) => [
              subject.key,
              ...(subject.aliases ?? [])
            ]),
            new Date(searchedAt.getTime() - TIER_SEARCH_SPACING_MS)
          )
        )
        .catch(() => [])
    );
    const tierSearches = tierSearchStates(
      searchSubjects,
      latestTierSearches,
      searchedAt,
      withEvidence
    );
    // A character past the display cap has no evidence row, so its tier
    // search is the only way the page learns that run is still going.
    const evidenceRunIds = [
      ...new Set([
        ...evidence.flatMap((item) => item.activeRunIds),
        ...latestTierSearches.flatMap((search) =>
          search.runId !== undefined && ACTIVE_RUN_STATUSES.has(search.status)
            ? [search.runId]
            : []
        )
      ])
    ];
    return applicantDossierSchema.parse({
      ...dossier,
      raids: dossier.raids.map((raid) => {
        const tierSearch = tierSearches.get(raid.raidId);
        return tierSearch ? { ...raid, tierSearch } : raid;
      }),
      // Every stored kill, not only the first kills the raids lead with: a
      // guild's history is the nights it raided, which the raids do not keep.
      guildHistory: collectGuildRaidNights(ranked.kills),
      lastCollectedAt:
        collectedTimes.length === 0
          ? null
          : new Date(Math.min(...collectedTimes)).toISOString(),
      ...(evidenceRunIds.length > 0 ? { evidenceRunIds } : {}),
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
      limitations: dossier.limitations.map(contractLimitation)
    });
  };
  return options.scope
    ? options.scope.time("assemble", assemble)
    : assemble((inner) => inner());
}

/** Highest level first, then by region, realm and name. */
function compareByLevelThenKey(
  left: Readonly<{ level: number; key: CharacterKey }>,
  right: Readonly<{ level: number; key: CharacterKey }>
): number {
  return (
    right.level - left.level ||
    left.key.region.localeCompare(right.key.region, "en") ||
    left.key.realm.localeCompare(right.key.realm, "en") ||
    left.key.name.localeCompare(right.key.name, "en")
  );
}

/** The character a submitted URL names, or null when it names none. */
function parseTarget(url: string): CharacterKey | null {
  try {
    return parseApplicantCharacterUrl(url);
  } catch {
    return null;
  }
}

export function createApplicantDossierService(options: {
  repositories: Pick<
    Repositories,
    "snapshots" | "evidence" | "manualConnections" | "recentSearches" | "runs"
  >;
  queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
  search: Pick<SearchService, "create" | "scheduleConnectedCharacterSweep">;
  blizzard: Pick<BlizzardGateway, "getCompletedAchievements">;
  raiderio: Pick<RaiderIoGateway, "getCharacter" | "getMythicBossRankings">;
  config: ApplicationConfig;
  evidenceJobCredentialEncryptionKey: Buffer;
  onCacheEvent?: ((source: string, event: string) => void) | undefined;
  logger?: { info(value: Record<string, unknown>): void };
}): ApplicantDossierService {
  const { gatewaysFor, scopedConcurrency } = createDossierGateways(options);
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
    root: CharacterKey,
    character: CharacterKey,
    scope?: MeasurementScope
  ): Promise<void> {
    try {
      await refreshCharacter({
        key: character,
        origin: "historic_alias",
        root,
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
  // A reader's refresh and an operator's rebuild are the same request, except
  // that a rebuild first forgets the character's terminal marks.
  function requestCollection(
    key: CharacterKey,
    scope: MeasurementScope | undefined,
    request: Pick<
      Parameters<typeof refreshCharacter>[0],
      "rebuild" | "credentials"
    > & { origin: "refresh" | "rebuild" }
  ): Promise<RefreshCharacterResult> {
    return refreshCharacter({
      key,
      // Both are addressed to one character, not to a dossier.
      root: null,
      at: new Date(),
      cooldownMs: REFRESH_COOLDOWN_MS,
      repositories: options.repositories,
      queue: options.queue,
      ...request,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(scope ? { scope } : {})
    });
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
        await repositories.snapshots.getCurrentDeclaringCharacter?.(key)
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
      return rootOrder || compareByLevelThenKey(left, right);
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
      options.config.DOSSIER_CHARACTER_CEILING
    );
    const skipped = includedOrdered.slice(selected.length);
    // Excluded characters are ranked among themselves only, so one of them
    // never costs a researchable character its place under the ceiling.
    const excludedOrdered = [...excludedIdentities].sort(compareByLevelThenKey);
    return {
      snapshot,
      selected,
      skipped,
      excludedOrdered,
      provisional: own === null
    };
  }

  /** What every dossier assembly for one read shares, whoever it covers. */
  function assemblyContext(
    repositories: ReturnType<typeof scopedRepositories>,
    signal?: AbortSignal,
    overrides?: DossierGatewayOverrides,
    scope?: MeasurementScope
  ) {
    return {
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
      encryptionKey: options.evidenceJobCredentialEncryptionKey,
      scope
    };
  }

  async function readRootOnly(
    key: CharacterKey,
    hasStoredEvidence: boolean,
    evidenceOrigin: DossierReadOrigin,
    context: ReturnType<typeof assemblyContext>
  ): Promise<ReadDossierResult> {
    return {
      kind: "ready",
      dossier: await assembleDossier({
        root: key,
        evidenceOrigin,
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
        ...context
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
      await queueHistoricAliasRecollection(root, character, scope);
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
      await queueHistoricAliasRecollection(root, character, scope);
      return "removed";
    },
    async readEvidencePhases(runId) {
      return options.repositories.evidence.listPhases?.(runId) ?? [];
    },
    async readEvidenceRunProgress(ids, scope) {
      if (ids.length === 0) return [];
      const progress =
        (await scopedRepositories(scope).evidence.readRunProgress?.(
          ids,
          new Date()
        )) ?? [];
      return progress.map(evidenceRunProgressView);
    },
    async start(input, scope) {
      // start does real database and queue work through search.create, so its
      // scope is threaded through rather than discarded: this is the endpoint
      // the research doc measures as "submission to first response".
      const key = parseTarget(input.characterUrl);
      if (!key) return { kind: "invalid", code: "invalid_character_url" };
      const command = { ...input, characterUrl: toRaiderIoUrl(key) };
      const result = scope
        ? await options.search.create(command, scope)
        : await options.search.create(command);
      // Only a search that opened a dossier is listed; a refused, suppressed
      // or unknown character is not. The list is a convenience, so failing to
      // record the search must not fail the search itself.
      if (result.kind === "job" || result.kind === "character") {
        await scopedRepositories(scope)
          .recentSearches?.record(key)
          .catch(() => {
            options.logger?.info({ event: "dossier_search_record_failed" });
          });
      }
      return result;
    },

    async listRecentSearches(limit, scope) {
      return (
        (await scopedRepositories(scope).recentSearches?.listRecent(limit)) ??
        []
      );
    },

    async addConnectedCharacter(root, input, scope) {
      const target = parseTarget(input.characterUrl);
      if (!target) return { kind: "invalid", code: "invalid_character_url" };
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
      const target = parseTarget(input.characterUrl);
      if (!target) return { kind: "invalid", code: "invalid_character_url" };
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
      const target = parseTarget(input.characterUrl);
      if (!target) return { kind: "invalid", code: "invalid_character_url" };
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
      return requestCollection(key, scope, {
        origin: "refresh",
        credentials: overrides?.wclCredentialRef
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
        root: key,
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
      return requestCollection(key, scope, {
        origin: "rebuild",
        rebuild: true
      });
    },

    async readInitial(key, signal, overrides, scope) {
      const repositories = scopedRepositories(scope);
      const hasStoredEvidence =
        (await repositories.evidence.getCompleted(key)) !== null;
      if (!hasStoredEvidence) {
        // Collecting a character nobody has evidence for is the expensive half
        // of a search, so it happens only while a search's discovery run is
        // active: the one case the web client asks for the initial scope in.
        // Without that, a direct call queued a full collection at public-read
        // limits and left no search behind (#709).
        if (!(await repositories.runs.findActive(key)))
          return { kind: "not_ready" };
        // Initial evidence precedes the worker's snapshot filter. Completed
        // evidence is already public dossier material; without it, one bounded
        // lookup prevents a tournament root from appearing before the current
        // discovery finishes.
        const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
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
        "dossier_initial",
        assemblyContext(repositories, signal, overrides, scope)
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
        return readRootOnly(
          key,
          true,
          "dossier_read",
          assemblyContext(repositories, signal, overrides, scope)
        );
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
          evidenceOrigin: "dossier_read",
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
          ...assemblyContext(repositories, signal, overrides, scope)
        })
      };
    }
  };
}
