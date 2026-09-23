import type {
  CharacterMythicKillInput,
  CharacterCuttingEdgeInput,
  CharacterMythicWipeInput,
  CharacterTierBestParseInput,
  DiscoveryWorkContext,
  EmptyAttendanceSearch,
  EvidenceRunCost,
  EvidenceRunPhase,
  StagedEvidenceCollection,
  HistoricAliasScanProgress,
  StoredEvidenceTiers,
  TerminalTier
} from "@slashwho/database";
import type { BlizzardGateway } from "@slashwho/blizzard";
import type { CharacterKey } from "@slashwho/domain";
import {
  canonicalCharacterId,
  isAccountWideCuttingEdgeAchievement
} from "@slashwho/domain";
import type {
  MythicBossRanking,
  MythicBossRankingsOptions,
  RaiderIoGateway
} from "@slashwho/raiderio";
import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsGateway,
  WarcraftLogsReportResult,
  WarcraftLogsLimitationCode,
  WarcraftLogsQueryType,
  WarcraftLogsRateLimit,
  WarcraftLogsTierSearchOutcome
} from "@slashwho/warcraftlogs";

import { decryptCredential } from "./credential-encryption";
import { errorFields } from "./error-fields";
import {
  classifyEvidenceFailure,
  evidenceRetryDecision
} from "./evidence-retry-policy";
import {
  drivingParseLimitation,
  retryDelayMsFor
} from "./limitation-retry-policy";
import { measuredRepositories } from "./measured-repositories";
import { createMeasurementScope } from "./measurement";
import { queueWaitMs } from "./queue-wait";
import {
  fromStagedCollection,
  terminalTiersFromStage,
  toStagedCollection,
  type EvidenceLimitationCode,
  type EvidencePublication
} from "./evidence-publication";
import { killScanFloorFrom, terminalTiersFrom } from "./terminal-tiers";

/** Keep one publication under the connected key while scanning former names. */
function mergeHistoricAliasResponse(
  current: WarcraftLogsReportResult,
  historic: WarcraftLogsReportResult
): WarcraftLogsReportResult {
  if (current.kind === "limitation") {
    if (historic.kind === "limitation") return current;
    return {
      ...historic,
      historyScanResumePage: undefined,
      historyScanResumeBoundaryReportCode: undefined,
      limitation: current
    };
  }
  if (historic.kind === "limitation") {
    return { ...current, limitation: historic };
  }
  const distinct = <T>(
    values: readonly T[],
    key: (value: T) => string
  ): T[] => [...new Map(values.map((value) => [key(value), value])).values()];
  return {
    ...current,
    kills: distinct(
      [...current.kills, ...historic.kills],
      (kill) => kill.fightUrl
    ),
    wipes: distinct(
      [...current.wipes, ...historic.wipes],
      (wipe) => wipe.fightUrl
    ),
    tierBests: distinct(
      [...current.tierBests, ...historic.tierBests],
      (parse) => `${parse.raidId}/${parse.bossId}/${parse.rankingsUrl}`
    ),
    parsedFightUrls: distinct(
      [...current.parsedFightUrls, ...historic.parsedFightUrls],
      (url) => url
    ),
    troubledRaidIds: {
      parses: [
        ...new Set([
          ...current.troubledRaidIds.parses,
          ...historic.troubledRaidIds.parses
        ])
      ],
      tierBests: [
        ...new Set([
          ...current.troubledRaidIds.tierBests,
          ...historic.troubledRaidIds.tierBests
        ])
      ]
    },
    ...(current.limitation || historic.limitation
      ? { limitation: current.limitation ?? historic.limitation }
      : {}),
    ...(current.parseLimitation || historic.parseLimitation
      ? { parseLimitation: current.parseLimitation ?? historic.parseLimitation }
      : {}),
    parseLimitations: [
      ...(current.parseLimitations ?? []),
      ...(historic.parseLimitations ?? [])
    ]
  };
}
import {
  EMPTY_SEARCH_RECHECK_MS,
  emptySearchKey,
  raiderIoVerifiedKills,
  storedKillReportCodes
} from "./verified-kills";
import {
  DEFAULT_TIER_SEARCH_REQUEST_CAP,
  tierSearchGuilds,
  tierSearchRequestCaps,
  tierSearchWindow,
  tierSearchZoneIds
} from "./tier-search";
import {
  createEvidencePhaseLedger,
  fullEvidencePhasePlan,
  type EvidencePhase
} from "./evidence-phase-ledger";
import {
  historicWorldRankForKill,
  raiderIoRankingRequest,
  rankingRequestKey
} from "./historic-world-rank";

export type ApplicantEvidenceRun = Readonly<{
  id: string;
  key: CharacterKey;
  status: "queued" | "running" | "retrying" | "complete" | "partial" | "failed";
  createdAt: Date;
  wclClientIdEncrypted: string | null;
  wclClientSecretEncrypted: string | null;
  className?: string | null;
  /**
   * What the run was reserved to do. A `tier_search` run is a full collection
   * that also walks `tierSearchRaidId`'s guild attendance (#435). Absent is
   * `full`.
   */
  mode?: "full" | "tier_search";
  tierSearchRaidId?: string | null;
}>;

export type { EvidenceLimitationCode };

export type ApplicantEvidenceStore = {
  find(runId: string): Promise<ApplicantEvidenceRun | null>;
  claim(runId: string, attempt: number): Promise<ApplicantEvidenceRun | null>;
  seedPhases?(
    runId: string,
    phases: readonly { id: string; ordinal: number }[]
  ): Promise<void>;
  recordPhaseTransitions?(
    runId: string,
    phases: readonly Omit<EvidenceRunPhase, "ordinal">[]
  ): Promise<void>;
  listPhases?(runId: string): Promise<readonly EvidenceRunPhase[]>;
  publish(
    runId: string,
    result: Readonly<{
      state: "complete" | "partial";
      historicAliasProgress?: StagedEvidenceCollection["historicAliasProgress"];
      limitationCode: EvidenceLimitationCode | null;
      parseLimitationCode: EvidenceLimitationCode | null;
      retryAfterAt?: Date | null;
      kills: readonly CharacterMythicKillInput[];
      wipes: readonly CharacterMythicWipeInput[];
      tierBests: readonly CharacterTierBestParseInput[];
      cuttingEdges?: readonly CharacterCuttingEdgeInput[];
      /**
       * Fight URLs this run asked about and got an answer for. Named here
       * rather than left to structural typing so an implementation cannot
       * quietly drop it: unrecorded, a fight answered with no ranking is
       * re-requested on every later run (#297).
       */
      parsedFightUrls?: readonly string[];
      completedAt: Date;
    }>
  ): Promise<void>;
  fail(runId: string, code: EvidenceLimitationCode): Promise<void>;
  /**
   * Records why a still-active run collected nothing. A refusal publishes
   * nothing, so this is the only way the reason reaches a reader.
   */
  recordLimitation(runId: string, code: EvidenceLimitationCode): Promise<void>;
  /**
   * Records what this attempt spent and the configuration it spent it under,
   * so the points budget can be re-derived by query rather than by grepping
   * deployment logs (#342).
   */
  recordRunCost(cost: EvidenceRunCost): Promise<void>;
  /**
   * Verified kills whose night an attendance search covered to the end and
   * found empty since `searchedSince` (#434). Optional: a store without it
   * searches every verified kill, which is only slower.
   */
  emptyAttendanceSearches?(
    key: CharacterKey,
    searchedSince: Date
  ): Promise<readonly EmptyAttendanceSearch[]>;
  recordEmptyAttendanceSearches?(
    key: CharacterKey,
    searches: readonly EmptyAttendanceSearch[],
    at: Date
  ): Promise<void>;
  /**
   * Holds a finished collection between the scan that paid for it and the
   * publication that stores it, so a retry republishes rather than re-collects.
   */
  stageCollection(
    runId: string,
    payload: StagedEvidenceCollection
  ): Promise<void>;
  /** The stage this run already holds, if a previous attempt left one. */
  stagedCollection(runId: string): Promise<StagedEvidenceCollection | null>;
  /** Former names explicitly linked to this character by a reviewer. */
  historicAliases?(key: CharacterKey): Promise<readonly CharacterKey[]>;
  /**
   * Remembers the stable Warcraft Logs character ID the run's key resolved to.
   * Optional so a store without it still collects, reading by name.
   */
  recordWarcraftLogsCharacterId?(
    key: CharacterKey,
    characterId: number,
    at: Date
  ): Promise<void>;
  /**
   * Fight URLs whose parses are already stored for this character, so a
   * budget-limited run spends its requests on what is still missing rather
   * than redoing the same reports on every run.
   */
  hydratedFightUrls(
    key: CharacterKey,
    settledBefore: Date
  ): Promise<readonly string[]>;
  /**
   * The tiers this character is finished with, so the run spends no request on
   * them, and the means to record the ones it has just finished with.
   */
  /**
   * Where and when this character's stored kills and wipes happened, which is
   * what turns a terminal raid id into a date the report scan can stop at.
   */
  storedEvidenceTiers(
    key: CharacterKey,
    tierSearchRaidId?: string
  ): Promise<StoredEvidenceTiers>;
  terminalTiers(key: CharacterKey): Promise<readonly TerminalTier[]>;
  markTerminalTiers(
    key: CharacterKey,
    tiers: readonly TerminalTier[],
    at: Date
  ): Promise<void>;
  /**
   * When each zone's tier bests were last collected, as `[raidId, completedAt]`
   * pairs, so a zone with nothing left to fetch neither spends a request nor
   * counts towards the run's zone budget.
   */
  collectedTierZones(
    key: CharacterKey
  ): Promise<readonly (readonly [string, string])[]>;
};

/**
 * Announces an evidence run to whoever is watching. Evidence runs spend the
 * Warcraft Logs allowance, so a run that starts, stalls or drains it should be
 * visible without anyone deliberately querying for it.
 *
 * Both calls carry only what `evidence_job` already records: run identity, the
 * canonical (public) character key, the attempt and the outcome. Never the
 * run's credentials, an owner id or a correlation id.
 *
 * Delivery is the implementation's problem and is best effort. The handler
 * treats either call throwing as a non-event.
 */
export type EvidenceRunNotifier = {
  started(run: {
    runId: string;
    region: string;
    realm: string;
    name: string;
    attempt: number;
  }): Promise<void> | void;
  finished(run: {
    runId: string;
    region: string;
    realm: string;
    name: string;
    attempt: number;
    outcome: string;
    limitationCode: string | null;
    parseLimitationCode: string | null;
    pointsSpent: number | null;
    /** Whether this attempt earned another one, and why. */
    retryDecision?: string;
    retryReason?: string | null;
  }): Promise<void> | void;
};

export type ApplicantEvidenceJobHandlerOptions = Readonly<{
  evidence: ApplicantEvidenceStore;
  warcraftLogs: Pick<
    WarcraftLogsGateway,
    "getFirstKillReports" | "getRateLimit"
  > &
    Partial<Pick<WarcraftLogsGateway, "resolveCharacter">>;
  blizzard?: Pick<BlizzardGateway, "getCompletedAchievements">;
  raiderio?: Pick<RaiderIoGateway, "getMythicBossRankings"> &
    Partial<Pick<RaiderIoGateway, "getHistoricMythicKills">>;
  createWarcraftLogsGateway?: (credentials: {
    clientId: string;
    clientSecret: string;
  }) => Pick<WarcraftLogsGateway, "getFirstKillReports" | "getRateLimit"> &
    Partial<Pick<WarcraftLogsGateway, "resolveCharacter">>;
  decryptionKey?: Buffer;
  requestCap: number;
  parseRequestCap: number;
  /**
   * The most requests a tier search may make. It is carved out of the scan
   * cap, never added to it, so it cannot move the run's points budget.
   */
  tierSearchRequestCap?: number;
  /**
   * How long a run that exhausted one of its own request budgets waits before
   * it is collectable again. A capped run records that work is outstanding,
   * and `retry_after_at` is the one signal that makes `reserve` hand it back:
   * with no retry the run stays fresh for the full 24 hours and the character
   * settles permanently short of the data it knows it did not fetch.
   */
  capRetryMs: number;
  /**
   * How long a run stopped by something outside itself -- an unreachable
   * upstream, or throttling that carried no `Retry-After` -- waits before it
   * is collectable again. Applied only where upstream supplied no hint of its
   * own; see `retryDelayMsFor` for which codes get one and which are left
   * alone.
   */
  transientRetryMs: number;
  /**
   * How many Warcraft Logs points must remain unspent this hour before a run
   * may start. The gateway reports the allowance; this is the policy applied
   * to it.
   */
  pointsReserve: number;
  /**
   * How long after a kill its rankings are taken to have settled. A kill
   * younger than this is re-read rather than frozen, and its tier cannot go
   * terminal.
   *
   * The default of seven days is a guess, like `EVIDENCE_POINTS_RESERVE`. Two
   * attempts to measure the settling period retrospectively failed, so the
   * observation times now stored alongside each percentile are what should
   * eventually replace it.
   */
  killSettleMs: number;
  /**
   * Points above which a failed attempt is not retried, whatever kind of fault
   * it was. A retry that repeats a 2,500-point collection is not comparable to
   * one that repeats a cheap request, and #292 paid for five of the former.
   * 0 switches the veto off.
   */
  retryCostCeiling: number;
  /**
   * How long a run that stopped on a fault waits before a reader may reserve
   * another. `failed` is invisible to `reserve` -- neither active nor
   * completed -- so a run that stops without this is re-reserved by the very
   * next page read, and a retry storm becomes a reservation storm.
   */
  failureCooldownMs: number;
  now?: () => Date;
  logger?: { info(value: Record<string, unknown>): void };
  evidenceRunNotifier?: EvidenceRunNotifier;
  monotonic?: () => number;
}>;

/**
 * Either a plain run id (existing callers) or a job payload carrying the
 * correlation id and enqueue time forwarded from the queue.
 */
export type ApplicantEvidenceJobInput =
  | string
  | Readonly<{
      runId: string;
      correlationId?: string;
      enqueuedAt?: string;
      /**
       * `light` reads only the most recent page of reports. A manual refresh
       * inside its cooldown uses it to look for a new raid night without
       * spending a whole history's worth of requests.
       */
      mode?: "full" | "light";
    }>;

function toCharacterMythicKillInput(
  kill: WarcraftLogsFirstKillEvidence
): CharacterMythicKillInput {
  return {
    raidId: kill.raidId,
    raidName: kill.raidName,
    bossId: kill.bossId,
    bossName: kill.bossName,
    journalBossId: kill.journalBossId,
    bossOrder: kill.bossOrder,
    killedAt: kill.killedAt,
    reportUrl: kill.reportUrl,
    fightUrl: kill.fightUrl,
    guild: kill.guild,
    ...(kill.uploader === undefined ? {} : { uploader: kill.uploader }),
    performance: kill.performance
  };
}

const MAX_RAIDER_IO_RANKING_REQUESTS_PER_RUN = 50;
const RAIDER_IO_RANKING_CONCURRENCY = 4;

/**
 * Log-field prefix per class of upstream Warcraft Logs request. A closed map
 * authored in source rather than a name derived from the query type, so every
 * field on the `evidence_job` record is greppable from the field name alone.
 */
const REQUEST_COUNTER_PREFIX: Readonly<Record<WarcraftLogsQueryType, string>> =
  {
    history_scan: "warcraftLogsHistoryScan",
    character_guilds: "warcraftLogsCharacterGuilds",
    guild_attendance: "warcraftLogsGuildAttendance",
    report_hydration: "warcraftLogsReportHydration",
    zone_rankings: "warcraftLogsZoneRankings",
    fight_parses: "warcraftLogsFightParses",
    ranking_identities: "warcraftLogsRankingIdentities"
  };

// The queue's own ceiling. `requestedRetryDelaySeconds` rejects anything above
// `retryDelayMax` and the job then falls back to `retryDelay: 1` with backoff,
// retrying almost immediately into another refusal. `pointsResetIn` reaches
// 3600, so a long reset costs one extra attempt; by the second refusal the
// reset is necessarily within this window.
const MAXIMUM_REFUSAL_RETRY_SECONDS = 1_800;

type PointsBudgetRefusal = Error & {
  readonly retryable: true;
  readonly retryAfterMs: number;
  readonly code: "points_budget_low";
};

function pointsBudgetRefusal(resetInSeconds: number): PointsBudgetRefusal {
  // Whole seconds, at least 1 and at most 1800: outside that range
  // `requestedRetryDelaySeconds` returns null and the delay is discarded.
  const delaySeconds = Math.min(
    Math.max(Math.ceil(resetInSeconds), 1),
    MAXIMUM_REFUSAL_RETRY_SECONDS
  );
  return Object.assign(new Error("evidence_points_budget_low"), {
    retryable: true as const,
    retryAfterMs: delaySeconds * 1_000,
    code: "points_budget_low" as const
  });
}

/**
 * The final attempt asks for no retry: there is none left to schedule, and a
 * retryable error would send the queue to `updateActiveRetryDelay`, whose
 * `AND state = 'active'` matches no row once the job is failing. That throws,
 * replacing this refusal and losing the cause from the logs.
 */
function terminalPointsBudgetRefusal(): Error & {
  readonly code: "points_budget_low";
} {
  return Object.assign(new Error("evidence_points_budget_low"), {
    code: "points_budget_low" as const
  });
}

function isPointsBudgetRefusal(error: unknown): error is PointsBudgetRefusal {
  return (
    error instanceof Error &&
    (error as Partial<PointsBudgetRefusal>).code === "points_budget_low"
  );
}

function remainingPoints(budget: WarcraftLogsRateLimit): number {
  return budget.limitPerHour - budget.pointsSpentThisHour;
}

/**
 * The configured reserve is sized for the worker's own allowance, but a run may
 * carry a visitor's credentials, and their account's limit is its own -- 3600
 * by default against the worker's 18000. Applied flat, a worker-sized reserve
 * fences off a visitor's entire budget and refuses every run they could make.
 * Capping it at a share of the *reported* allowance keeps the intent -- leave
 * room for roughly one more run -- at any account size, and can only lower the
 * configured value, never raise it.
 *
 * The share is 0.3 because 0.1 was quietly deciding the reserve. At the
 * worker's 18000 it clipped any configured value to 1800, and #295 measured a
 * real collection at up to 2906 points: a 1800 ceiling cannot express "leave
 * room for one more run" when one more run costs that much. 0.3 of 18000 is
 * 5400, so the measured 3500 default reaches the gate intact, and a visitor's
 * 3600 account keeps a 1080 reserve -- which the same measurement says is
 * about the least a collection can cost.
 */
const MAXIMUM_RESERVE_SHARE_OF_ALLOWANCE = 0.3;

function effectiveReserve(limitPerHour: number, configured: number): number {
  return Math.min(
    configured,
    limitPerHour * MAXIMUM_RESERVE_SHARE_OF_ALLOWANCE
  );
}

/**
 * The history scan is what a run mostly spends its points on, and the request
 * cap is a flat page count applied to whichever account the run carries -- the
 * gap `effectiveReserve` already closes for the reserve, left open on the knob
 * that decides what a *started* run costs (#320).
 *
 * The scan's share of a run was measured on 2026-09-18: 58-89% of spend, and
 * all of the variance, since fight parses sit at a near-constant 33-43 requests
 * against their own cap while the scan ranges from 32 to 190 pages. A visitor's
 * 3600 allowance against a flat 500 means one run may plan a scan several times
 * their whole hourly budget.
 *
 * A BACKSTOP, NOT A GUARANTEE. It bounds one run's share of an allowance; it
 * does not promise the run finishes.
 *
 * That is worth the arithmetic, because this constant and
 * MAXIMUM_RESERVE_SHARE_OF_ALLOWANCE are the two halves of a run's budget and
 * they used to combine only in a reader's head. Admission guarantees a run
 * starts with at least `effectiveReserve` points left. A run may then spend
 * `cap * pointsPerPage` on the scan plus a flat parse term -- the parse cap in
 * requests at ~13 points each, which does not scale with the allowance at all.
 * At EVIDENCE_PARSE_REQUEST_CAP's default of 24 that term is ~317:
 *
 *   worker, 18000:  admission guarantees >=3500; cap 300 pages
 *                   worst run 300*20 + 317 = 6317, and 9317 at 30 a page
 *   visitor, 3600:  admission guarantees >=1080; cap  18 pages
 *                   worst run  18*20 + 317 =  677, and  857 at 30 a page
 *
 * The worker's does not close, by a wide margin. The visitor's does, at both
 * page costs -- but read that as an accident of the current numbers rather
 * than a property anything maintains. The parse term is flat, so it eats the
 * margin directly: at a parse cap of 48, which Railway ran as an override
 * until 2026-09-18, the visitor's worst run is 1174 against the same 1080 and
 * stops closing.
 *
 * Making the worker's close would mean 145 pages, below the deepest scan
 * already observed (190), truncating collections that currently finish. And
 * the reason is not arithmetic that can be rebalanced:
 * a deep character's history is ~3800 points of scan before a single parse,
 * which does not fit a 3600 allowance at any cap whatsoever. That case takes
 * more than one window by nature. An overrun already publishes partial, sets a
 * retry deadline and resumes, so it pays a deferral rather than losing work --
 * which is why bounding the share is the job here and completing the run is
 * not.
 *
 * These four lines are not the guard, only its explanation. The guard is
 * `evidence-run-budget.test.ts` in the worker, which computes the same
 * arithmetic from the real configured defaults and fails the build when any of
 * it moves -- the two shares, the page costs, or the parse cap, which is what
 * actually drifted first. If that test fails, fix the numbers here as well as
 * there: a comment nobody has to update is a comment that goes stale, which is
 * how this one came to describe a parse cap of 48 that had stopped being
 * deployed.
 */
const MAXIMUM_SCAN_SHARE_OF_OWN_ALLOWANCE = 0.5;

/**
 * The same bound on a visitor's allowance, which is theirs and not ours.
 *
 * This is a product decision, not a tuning constant. Spending the worker's
 * whole quota is a throughput choice we are entitled to make. Spending a
 * visitor's, repeatedly across windows until their character converges, is
 * spending someone else's resource -- and they supplied those credentials to
 * see one dossier, not to have their Warcraft Logs quota drained every hour.
 * So the slice is modest: 18 pages a run against a 3600 allowance, where our
 * own would take 60.
 *
 * THIS DOES NOT MERELY SLOW A VISITOR'S DOSSIER DOWN. Above the cap it does
 * not converge at all. A truncated scan raises a `request_cap` scan
 * limitation; `terminalTiersFrom` settles nothing when a scan limitation is
 * present; with nothing terminal `killScanFloorFrom` returns undefined; and
 * with no floor the next run starts at the newest report again and pages back
 * over the same 18 pages. At 10 reports a page that is the same 180 reports
 * forever, for any character with more than that.
 *
 * It is still an improvement on what it replaces -- a flat 500-page cap
 * exhausted a visitor's allowance around page 180 and was rate limited
 * mid-scan, so this trades failing expensively for failing cheaply -- but it
 * is not convergence, and the fix is not here. It is to narrow "a truncated
 * scan settles nothing" to "settles nothing below its stopping point": paging
 * is newest-first, so a raid whose kills all sit above the truncation point
 * was completely seen and is safe to mark. Tracked in #334.
 *
 * Keyed off whose credentials the run carries, never off how large the
 * allowance is. A small allowance only correlates with a visitor: the worker's
 * own tier moved from 9000 to 18000 inside a day on 2026-09-17, and a visitor
 * may hold a large account.
 */
const MAXIMUM_SCAN_SHARE_OF_VISITOR_ALLOWANCE = 0.15;

/**
 * Points per history-scan page, for converting that share into a page count.
 *
 * 30 is deliberately above the measurement, not equal to it. Two runs on
 * 2026-09-18 with identical zone and fight counts differed only in scan depth
 * -- 134 pages against 66, 2894 points against 1531 -- which solves directly to
 * about 20 a page with no model assumed. Dividing by the measured value would
 * make the share a floor rather than a ceiling: the cap is `share * limit / s`,
 * so the run spends `share * limit * (actual / assumed)`, and any page dearer
 * than the estimate spends *more* than the share, not less. A third run the
 * same evening does not fit a constant-cost model at all -- it implies a
 * negative fight cost -- so per-request costs are not uniform across
 * characters, and the divisor carries headroom for that.
 */
const HISTORY_SCAN_POINTS_PER_REQUEST = 30;

function effectiveRequestCap(
  limitPerHour: number,
  configured: number,
  credentials: "own" | "visitor"
): number {
  const share =
    credentials === "visitor"
      ? MAXIMUM_SCAN_SHARE_OF_VISITOR_ALLOWANCE
      : MAXIMUM_SCAN_SHARE_OF_OWN_ALLOWANCE;
  return Math.max(
    1,
    Math.min(
      configured,
      Math.floor((limitPerHour * share) / HISTORY_SCAN_POINTS_PER_REQUEST)
    )
  );
}

function storedKillForParse(
  kill: NonNullable<StoredEvidenceTiers["parseOnlyKills"]>[number],
  region: CharacterKey["region"]
): WarcraftLogsFirstKillEvidence | null {
  const reportCode = /\/reports\/([^/?#]+)/i.exec(kill.reportUrl)?.[1];
  const fightId = /[#?&]fight=(\d+)/i.exec(kill.fightUrl)?.[1];
  if (!reportCode || !fightId) return null;
  return {
    raidId: kill.raidId,
    raidName: kill.raidName,
    bossId: kill.bossId,
    bossName: kill.bossName,
    journalBossId: kill.journalBossId,
    bossOrder: kill.bossOrder,
    killedAt: kill.killedAt,
    reportCode,
    fightId: Number(fightId),
    // character_mythic_kills contains Mythic-only evidence, so the gateway's
    // Mythic difficulty constant is the only difficulty value available here.
    difficulty: 5,
    performance: kill.performance,
    reportUrl: kill.reportUrl,
    fightUrl: kill.fightUrl,
    guild: kill.guild ? { ...kill.guild, region } : null,
    uploader: kill.uploader ?? null
  };
}

/**
 * What a page of report history actually cost, as opposed to what the cap
 * assumes. Solved directly from a matched pair on 2026-09-18: two runs with
 * identical zone and fight counts, 134 pages against 66, 2894 points against
 * 1531. Used for the optimistic end of a worst-case estimate; nothing sizes a
 * budget from it, for the reason on HISTORY_SCAN_POINTS_PER_REQUEST.
 */
const MEASURED_HISTORY_SCAN_POINTS_PER_REQUEST = 20;

/**
 * Points a fight-parse request costs, fitted across the runs that carry
 * per-query-type counters. Only the flat parse term uses it.
 */
const FIGHT_PARSE_POINTS_PER_REQUEST = 13.2;
/** Conservative upper estimate used when deriving a new parse-only cap. */
const FIGHT_PARSE_POINT_BOUND = 14;
const KILL_SCAN_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export type EvidenceRunBudget = Readonly<{
  /** Pages of report history this run may scan. */
  scanPages: number;
  /** Points admission guarantees are still unspent when the run starts. */
  reservedPoints: number;
  /** The parse term, which does not scale with the allowance. */
  parsePoints: number;
  /** Worst-case run cost at the measured page cost, and at the assumed one. */
  worstCaseAtMeasuredCost: number;
  worstCaseAtAssumedCost: number;
  /**
   * Whether the worst case fits inside what admission guarantees, judged at
   * the assumed page cost. False is not a fault: see
   * MAXIMUM_SCAN_SHARE_OF_OWN_ALLOWANCE, which explains why closing the
   * worker's budget would truncate collections that currently finish.
   */
  closes: boolean;
}>;

/**
 * The whole of a run's points budget in one place, so the relationship between
 * the scan share, the reserve share and the flat parse term can be evaluated
 * rather than recited.
 *
 * On the handler's own path, not beside it: the scan cap a production run gets
 * comes from here. That is deliberate -- a model kept only for a test drifts
 * from the thing it models, which is the failure being guarded against -- but
 * it means a bug here is a production bug, so it takes the same parameters the
 * calculation actually uses and fabricates nothing. An earlier version built a
 * synthetic `WarcraftLogsRateLimit` to pass along, with `pointsSpentThisHour`
 * and `pointsResetInSeconds` invented as zero. Harmless while both helpers read
 * only `limitPerHour`, and a trap the moment either starts reading a field that
 * was never real.
 *
 * This exists because the arithmetic in MAXIMUM_SCAN_SHARE_OF_OWN_ALLOWANCE
 * went stale within a day of being written: it named a parse cap of 48 that
 * Railway stopped overriding, and nothing failed. A comment can only ask a
 * human to remember to redo it. `evidence-run-budget.test.ts` in the worker
 * evaluates this against the real configured defaults instead, so a constant
 * moving anywhere breaks the build.
 */
export function evidenceRunBudget(
  input: Readonly<{
    limitPerHour: number;
    credentials: "own" | "visitor";
    requestCap: number;
    parseRequestCap: number;
    pointsReserve: number;
    scanPages?: number;
  }>
): EvidenceRunBudget {
  const scanPages =
    input.scanPages ??
    effectiveRequestCap(
      input.limitPerHour,
      input.requestCap,
      input.credentials
    );
  const reservedPoints = effectiveReserve(
    input.limitPerHour,
    input.pointsReserve
  );
  const parsePoints = input.parseRequestCap * FIGHT_PARSE_POINTS_PER_REQUEST;
  const worstCaseAtAssumedCost =
    scanPages * HISTORY_SCAN_POINTS_PER_REQUEST + parsePoints;
  return {
    scanPages,
    reservedPoints,
    parsePoints,
    worstCaseAtMeasuredCost:
      scanPages * MEASURED_HISTORY_SCAN_POINTS_PER_REQUEST + parsePoints,
    worstCaseAtAssumedCost,
    closes: worstCaseAtAssumedCost <= reservedPoints
  };
}

export function parseOnlyRequestCap(
  input: Readonly<{
    limitPerHour: number;
    pointsReserve: number;
  }>
): number {
  const reservedPoints = effectiveReserve(
    input.limitPerHour,
    input.pointsReserve
  );
  return Math.max(1, Math.floor(reservedPoints / FIGHT_PARSE_POINT_BOUND));
}

/**
 * Collects one character's complete public Warcraft Logs history outside the
 * web request deadline. Only normalized gateway facts are handed to storage.
 */
type PhaseLedger = ReturnType<typeof createEvidencePhaseLedger>;

/** Progress is observational; its storage failure cannot change collection. */
function bestEffortPhaseLedger(ledger: PhaseLedger): PhaseLedger {
  const attempt = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch {
      // The evidence publication remains the source of truth for the run.
    }
  };
  return {
    seed: () => attempt(() => ledger.seed()),
    transition: (...args) => attempt(() => ledger.transition(...args)),
    unknownStop: () => attempt(() => ledger.unknownStop()),
    cancelActive: () => attempt(() => ledger.cancelActive()),
    failActive: (...args) => attempt(() => ledger.failActive(...args)),
    skipPending: () => attempt(() => ledger.skipPending()),
    skipPendingBefore: (...args) =>
      attempt(() => ledger.skipPendingBefore(...args))
  };
}

export function createApplicantEvidenceJobHandler(
  options: ApplicantEvidenceJobHandlerOptions
) {
  const now = options.now ?? (() => new Date());

  /**
   * How long this limitation should defer the character, or `null` for one
   * that waiting cannot help. An upstream `Retry-After` always wins: upstream
   * knows better than a configured default when upstream will be ready.
   */
  function retryDelayMs(
    limitation:
      | Readonly<{ code: WarcraftLogsLimitationCode; retryAfterMs?: number }>
      | null
      | undefined
  ): number | null {
    if (!limitation) return null;
    return (
      limitation.retryAfterMs ??
      retryDelayMsFor(limitation.code, {
        transientRetryMs: options.transientRetryMs,
        capRetryMs: options.capRetryMs
      })
    );
  }

  return {
    async execute(
      input: ApplicantEvidenceJobInput,
      context?: DiscoveryWorkContext
    ): Promise<void> {
      const job = typeof input === "string" ? { runId: input } : input;
      const monotonic = options.monotonic ?? (() => performance.now());
      const scope = createMeasurementScope(monotonic);
      const observedAt = monotonic();
      const activeContext = context ?? {
        attempt: 1,
        maxAttempts: 1,
        signal: new AbortController().signal
      };
      const evidence = measuredRepositories(
        { evidence: options.evidence },
        scope
      ).evidence;
      const record: Record<string, unknown> = {
        event: "evidence_job",
        runId: job.runId,
        correlationId: job.correlationId ?? null,
        queueWaitMs: queueWaitMs(job.enqueuedAt, now()),
        attempt: activeContext.attempt,
        outcome: "unknown",
        limitationCode: null,
        parseLimitationCode: null,
        killCount: 0,
        raiderIoHistoricOutcome: null,
        verifiedKillsSearched: null,
        verifiedKillsSkippedEmpty: null,
        attendanceRecoveredKills: null,
        // Null on a run that searched no tier, like every recovery field.
        tierSearchRaidId: null,
        tierSearchOutcome: null,
        tierSearchRecoveredKills: null,
        tierSearchRecoveredWipes: null,
        terminalTierCount: 0,
        // Overwritten with the effective cap once the allowance is read; this
        // is the value for a run that never got that far.
        requestCapUsed: options.requestCap,
        // Unlike the scan cap, this one does not scale with the reported
        // allowance, so configured and effective are the same number. It is
        // recorded anyway: it is the other half of what the run was given, and
        // the half whose divergence between code and Railway caused #295.
        parseRequestCapUsed: options.parseRequestCap,
        pointsLimitPerHour: null,
        pointsRemainingBefore: null,
        pointsSpentByRun: null,
        pointsRemainingAfter: null,
        // Present on every record so the shape does not change with the
        // outcome, and filled from whatever is caught below.
        errorName: null,
        errorCode: null,
        // Whether this attempt earned another one, and why. A closed
        // enumeration authored in source, like every other field here.
        retryDecision: null,
        retryReason: null,
        // How a stopped attempt left the run: published as partial, or failed
        // because the publication was itself what broke. `outcome` keeps
        // naming the fault, so neither answer displaces the other.
        stopDisposition: null,
        limitationQuery: null,
        durationMs: 0
      };
      // Set once the run is claimed, and the sole gate on announcing: a run
      // this execution never owned is neither started nor finished.
      let announced: CharacterKey | undefined;
      // The catch needs all three: which run this attempt owns, whether it got
      // as far as spending the allowance, and how to find out what it spent.
      let claimedRunId: string | undefined;
      // The tier this run was reserved to search, read off the run itself so a
      // re-claimed attempt is still a search. Undefined on every other run.
      let tierSearchRaidId: string | undefined;
      let tierSearchResult: WarcraftLogsTierSearchOutcome | undefined;
      let tierSearchStarved = false;
      let collectionBegan = false;
      // Whose allowance this attempt spent. Read in the `finally` as well as
      // by the budget, so it outlives the `try` that decides it.
      let usesVisitorCredentials = false;
      let sampleSpend: (() => Promise<void>) | undefined;
      let phaseLedger: ReturnType<typeof createEvidencePhaseLedger> | undefined;
      let phaseWrites = Promise.resolve();

      try {
        const run = await evidence.claim(job.runId, activeContext.attempt);
        if (!run) {
          record.outcome = "not_claimed";
          return;
        }
        // Announcing only once the claim succeeds keeps one run to one pair of
        // announcements however many workers race for it, and is the first
        // point at which there is a character to name.
        announced = run.key;
        claimedRunId = run.id;
        tierSearchRaidId =
          run.mode === "tier_search" && run.tierSearchRaidId
            ? run.tierSearchRaidId
            : undefined;
        record.tierSearchRaidId = tierSearchRaidId ?? null;
        try {
          await options.evidenceRunNotifier?.started({
            runId: job.runId,
            region: run.key.region,
            realm: run.key.realm,
            name: run.key.name,
            attempt: activeContext.attempt
          });
        } catch {
          options.logger?.info({
            event: "evidence_run_announcement_failed",
            runId: job.runId,
            phase: "started"
          });
        }

        // A previous attempt already paid for this collection upstream and
        // failed on the way to storage. Republishing it is the whole point of
        // the stage, so it happens before the admission gate: it spends
        // nothing, and refusing it for a low allowance would throw away work
        // already bought.
        const staged = await evidence.stagedCollection(run.id);
        if (staged) {
          record.outcome = "republished";
          record.limitationCode = staged.limitationCode;
          record.parseLimitationCode = staged.parseLimitationCode;
          record.killCount = staged.kills.length;
          await evidence.publish(run.id, fromStagedCollection(staged));
          // Marked here too, and for the same reason the collect path marks:
          // a republication that stored evidence and settled nothing left the
          // character re-paying for zones and scan pages the original run had
          // already earned the right to stop re-querying. Timed from the
          // stage's own `completedAt`, which is the instant the run that
          // collected it would have used.
          const stagedMarks = terminalTiersFromStage(
            staged,
            options.killSettleMs
          );
          record.terminalTierCount = stagedMarks.length;
          if (stagedMarks.length > 0) {
            await evidence.markTerminalTiers(
              run.key,
              stagedMarks,
              new Date(staged.completedAt)
            );
          }
          return;
        }

        // The run's own Warcraft Logs credentials when the enqueuing visitor
        // supplied them, the worker's shared gateway otherwise. The decrypted
        // values are used to build the gateway and never leave this scope:
        // nothing derived from them reaches `record`.
        // Whose allowance this run spends. The scan share differs by this and
        // not by how big the allowance turns out to be.
        usesVisitorCredentials = Boolean(
          run.wclClientIdEncrypted &&
          run.wclClientSecretEncrypted &&
          options.createWarcraftLogsGateway &&
          options.decryptionKey
        );
        const gateway =
          run.wclClientIdEncrypted &&
          run.wclClientSecretEncrypted &&
          options.createWarcraftLogsGateway &&
          options.decryptionKey
            ? options.createWarcraftLogsGateway({
                clientId: decryptCredential(
                  run.wclClientIdEncrypted,
                  options.decryptionKey
                ),
                clientSecret: decryptCredential(
                  run.wclClientSecretEncrypted,
                  options.decryptionKey
                )
              })
            : options.warcraftLogs;

        // Read from `gateway`, not `options.warcraftLogs`: a run carrying a
        // visitor's own credentials spends *their* allowance, and the worker's
        // shared allowance says nothing about it.
        //
        // A limitation here does not refuse the run. We are no worse off than
        // before this gate existed, and a gate that fails closed on its own
        // transport errors could stop all collection permanently.
        const budgetBefore = await gateway.getRateLimit(activeContext.signal);
        const openingBudget =
          budgetBefore.kind === "rate_limit" ? budgetBefore : null;
        if (openingBudget) {
          record.pointsLimitPerHour = openingBudget.limitPerHour;
          record.pointsRemainingBefore = remainingPoints(openingBudget);
          // A reserve of 0 is off, not "refuse once nothing remains": spend
          // overruns the limit (9058.65 against 9000 was observed), so the
          // remaining-points reading goes negative and a bare comparison would
          // gate hardest exactly when it was asked to stop.
          if (
            options.pointsReserve > 0 &&
            remainingPoints(openingBudget) <
              effectiveReserve(
                openingBudget.limitPerHour,
                options.pointsReserve
              )
          ) {
            // The run stays claimed and nothing is published. Leaving it
            // unclaimed instead would be a bug: `reserve` counts
            // ('queued','running','retrying') as active, so the character
            // would join a run that is never processed and never collect
            // again. Publishing instead risks the destructive merge of #250.
            record.outcome = "points_budget_low";
            record.limitationCode = "points_budget_low";
            // Nothing is published, so the run row is the only place a reader
            // can learn why the dossier is waiting rather than collecting.
            await evidence.recordLimitation(run.id, "points_budget_low");
            if (activeContext.attempt >= activeContext.maxAttempts) {
              // The queue is about to give up, and a run abandoned in
              // `running` is never collected again: `reserve` counts
              // ('queued','running','retrying') as active with no staleness
              // cutoff, so it would block every later reservation for this
              // character. `failed` is in neither that set nor
              // `loadCompletedEvidence`'s ('complete','partial'), so the
              // character falls back to its previous evidence and a later
              // read reserves a fresh run.
              await evidence.fail(run.id, "points_budget_low");
              throw terminalPointsBudgetRefusal();
            }
            throw pointsBudgetRefusal(openingBudget.pointsResetInSeconds);
          }
        }

        // Storage happens in two steps on purpose: the stage records that the
        // scan has been paid for, so a publication that fails transiently is
        // retried from the stage rather than from Warcraft Logs. `publish`
        // deletes it in its own transaction.
        // The trouble sets travel with the publication because terminal
        // marking needs them and nothing a settled run stores records them. A
        // stage is read by a re-claimed retry and by the recovery sweep alike,
        // and neither has the gateway response that raised them.
        const stageAndPublish = async (
          publication: EvidencePublication,
          troubledRaidIds: StagedEvidenceCollection["troubledRaidIds"]
        ) => {
          await evidence.stageCollection(
            run.id,
            toStagedCollection(publication, troubledRaidIds)
          );
          await evidence.publish(run.id, publication);
        };

        // Sampled by the success path and by the catch alike: what a failed
        // attempt cost is exactly what decides whether another one is
        // affordable (#292). Never at the cost of the collection it measures --
        // a failure to measure leaves the record null, which is what happened.
        sampleSpend = async () => {
          try {
            const budgetAfter = await gateway.getRateLimit(
              activeContext.signal
            );
            if (budgetAfter.kind === "rate_limit") {
              record.pointsRemainingAfter = remainingPoints(budgetAfter);
              if (openingBudget) {
                record.pointsSpentByRun =
                  budgetAfter.pointsSpentThisHour -
                  openingBudget.pointsSpentThisHour;
              }
            }
          } catch {
            // Left as null on the record: unmeasured, which is what happened.
          }
        };

        activeContext.signal.throwIfAborted();
        // A fight whose rankings have not settled is re-read rather than left
        // frozen at whatever it showed on the night.
        const settledBefore = new Date(now().getTime() - options.killSettleMs);
        const hydratedFightUrls = new Set(
          await options.evidence.hydratedFightUrls(run.key, settledBefore)
        );
        const collectedTierZones = new Map(
          await options.evidence.collectedTierZones(run.key)
        );
        const storedTerminal = await options.evidence.terminalTiers(run.key);
        const terminalRaidIds = {
          kills: new Set(
            storedTerminal
              .filter((tier) => tier.domain === "kills")
              .map((tier) => tier.raidId)
          ),
          parses: new Set(
            storedTerminal
              .filter((tier) => tier.domain === "parses")
              .map((tier) => tier.raidId)
          ),
          tierBests: new Set(
            storedTerminal
              .filter((tier) => tier.domain === "tier_bests")
              .map((tier) => tier.raidId)
          )
        };
        // How far back the report scan still has to page. Pages below this can
        // only re-find evidence already stored, so the scan stops there.
        const storedEvidence = await options.evidence.storedEvidenceTiers(
          run.key,
          tierSearchRaidId
        );
        // A capped ranked walk can accept an old-name fight before its cursor
        // reaches the next metric. Keep that already attributed fight in the
        // next publication, including when the next walk completes cleanly.
        const savedRankedCursor = storedEvidence.rankedBackfillCursor;
        const acceptedRankedKeys = new Set(
          savedRankedCursor?.acceptedFightKeys ?? []
        );
        const carriedRankedKills = (storedEvidence.parseOnlyKills ?? [])
          .map((kill) => storedKillForParse(kill, run.key.region))
          .filter(
            (kill): kill is WarcraftLogsFirstKillEvidence =>
              kill !== null &&
              // Stored WCL kills use zone IDs; journalRaidId names the
              // Encounter Journal raid selected for this search.
              savedRankedCursor?.zoneIds.includes(Number(kill.raidId)) ===
                true &&
              acceptedRankedKeys.has(`${kill.reportCode}:${kill.fightId}`)
          );
        const carriedRankedKeys = new Set(
          carriedRankedKills.map((kill) => `${kill.reportCode}:${kill.fightId}`)
        );
        // If an accepted fight is missing from storage, replay discovery so
        // the cursor cannot skip evidence the next publish would lose.
        const rankedCursor = [...acceptedRankedKeys].every((fightKey) =>
          carriedRankedKeys.has(fightKey)
        )
          ? savedRankedCursor
          : undefined;
        const killScanFloor = killScanFloorFrom(
          storedTerminal,
          storedEvidence.kills,
          storedEvidence.wipes
        );
        activeContext.signal.throwIfAborted();
        // A light refresh reads one page of reports. The gateway marks a
        // page-capped scan as a request-cap limitation, so the run publishes
        // as partial and the kills it did not revisit are preserved.
        // Scaled to the allowance the run's own credentials report, so a
        // visitor's account is not handed a page budget sized for the worker's.
        // A budget that could not be read falls back to the configured cap:
        // the gate above is allowed to fail open, and this has to inherit that
        // rather than scale off a limit it never saw.
        const scanFresh =
          storedEvidence.lastCleanKillScanAt !== undefined &&
          now().getTime() -
            new Date(storedEvidence.lastCleanKillScanAt).getTime() <
            KILL_SCAN_FRESHNESS_MS;
        const historicAliases =
          (await options.evidence.historicAliases?.(run.key)) ?? [];
        // Freshness alone is not evidence that this run is a parse resume. A
        // recent complete collection followed by a manual refresh still has
        // to look for new kills. The previous publication must also say that
        // parses were the only unfinished domain.
        // A tier search is asked for explicitly, so it always scans: skipping
        // the scan would publish a parse-only run for a request to look.
        const parseOnlyResume =
          tierSearchRaidId === undefined &&
          historicAliases.length === 0 &&
          scanFresh &&
          storedEvidence.parseWorkOutstanding === true;
        const scanCap = parseOnlyResume
          ? 0
          : openingBudget
            ? evidenceRunBudget({
                limitPerHour: openingBudget.limitPerHour,
                credentials: usesVisitorCredentials ? "visitor" : "own",
                requestCap: options.requestCap,
                parseRequestCap: options.parseRequestCap,
                pointsReserve: options.pointsReserve
              }).scanPages
            : options.requestCap;
        // A tier search spends part of the scan cap rather than adding to it.
        // A raid with no catalogued window has no nights to search, so the run
        // collects as an ordinary one would.
        const tierWindow =
          tierSearchRaidId === undefined
            ? null
            : tierSearchWindow(tierSearchRaidId, now());
        const tierCaps = tierWindow
          ? tierSearchRequestCaps(
              scanCap,
              options.tierSearchRequestCap ?? DEFAULT_TIER_SEARCH_REQUEST_CAP
            )
          : null;
        // Preserve the existing attendance allowance. Ranked discovery draws
        // a bounded share from history, and all three still fit the scan cap.
        const rankedCap = tierCaps
          ? Math.min(
              tierCaps.history,
              Math.max(1, Math.floor(tierCaps.tier / 2))
            )
          : 0;
        const requestCap =
          job.mode === "light"
            ? 1
            : tierCaps
              ? tierCaps.history - rankedCap
              : scanCap;
        const tierSearchAsked =
          tierWindow !== null && tierCaps !== null && tierCaps.tier > 0;
        // Asked for, with a tier to search, and no budget to search it with.
        // Recorded as such rather than as a search that never ran.
        tierSearchStarved = tierWindow !== null && !tierSearchAsked;
        // The search ignores the tier's terminal marks for its one run, so a
        // kill it recovers there is parsed and the tier's bests re-read. The
        // kill marks stay: they are what carries the tier's stored kills
        // through a complete publish, and the scan floor they set is what
        // keeps the history scan from re-reading the years below.
        if (tierSearchRaidId !== undefined && tierWindow) {
          for (const zone of tierSearchZoneIds(
            tierSearchRaidId,
            storedEvidence
          )) {
            terminalRaidIds.parses.delete(zone);
            terminalRaidIds.tierBests.delete(zone);
          }
        }
        const parseRequestCap =
          parseOnlyResume && openingBudget
            ? parseOnlyRequestCap({
                limitPerHour: openingBudget.limitPerHour,
                pointsReserve: options.pointsReserve
              })
            : options.parseRequestCap;
        // What the run was actually given, not what was configured. The two
        // were the same field until #320, and every record for a day named a
        // 500 that a run may never have been allowed to reach.
        record.requestCapUsed = requestCap;
        record.parseRequestCapUsed = parseRequestCap;
        collectionBegan = true;
        // This must match reservation exactly. Rebuilding only the WCL subset
        // makes real provider ids unknown to the ledger that owns them.
        const phasePlan = fullEvidencePhasePlan();
        const reservedPhases = await evidence
          .listPhases?.(run.id)
          .catch(() => undefined);
        const reservedPhaseIds = new Set(
          reservedPhases?.map((phase) => phase.id) ?? []
        );
        const hasReservedPhasePlan = phasePlan.every((id) =>
          reservedPhaseIds.has(id)
        );
        try {
          phaseLedger =
            hasReservedPhasePlan && evidence.recordPhaseTransitions
              ? bestEffortPhaseLedger(
                  createEvidencePhaseLedger({
                    plan: phasePlan,
                    initialPhases: reservedPhases,
                    now,
                    persist: async (phases) => {
                      const changed = phases.filter(
                        (item) => item.state !== "pending"
                      );
                      if (changed.length)
                        await evidence.recordPhaseTransitions!(
                          run.id,
                          changed.map((item) => ({
                            id: item.id,
                            state: item.state,
                            startedAt: item.startedAt ?? null,
                            completedAt: item.completedAt ?? null,
                            limitationCode: item.limitationCode ?? null
                          }))
                        );
                    }
                  })
                )
              : undefined;
        } catch {
          // A corrupt progress projection must not discard collected evidence.
          phaseLedger = undefined;
        }
        // Set only when Warcraft Logs resolved the run's own key: reads by
        // ID still match report actors against that key, so an ID for
        // whatever the name resolves to instead would read somebody else.
        let characterId: number | undefined;
        if (gateway.resolveCharacter) {
          await phaseLedger?.transition(
            "warcraft_logs_identity_resolution",
            "active"
          );
          try {
            const identity = await gateway.resolveCharacter(
              run.key,
              activeContext.signal
            );
            if (
              identity.kind === "identity" &&
              canonicalCharacterId(identity.key) ===
                canonicalCharacterId(run.key)
            ) {
              characterId = identity.characterId;
              // Bookkeeping, not evidence: a failed write must not cost the
              // collection it accompanies.
              await evidence
                .recordWarcraftLogsCharacterId?.(run.key, characterId, now())
                .catch(() => undefined);
            }
            await phaseLedger?.transition(
              "warcraft_logs_identity_resolution",
              identity.kind === "identity" ? "completed" : "limited",
              identity.kind === "limitation" ? identity.code : undefined
            );
          } catch (error) {
            if (activeContext.signal.aborted) throw error;
            await phaseLedger?.transition(
              "warcraft_logs_identity_resolution",
              "limited",
              "unavailable"
            );
          }
        } else {
          await phaseLedger?.transition(
            "warcraft_logs_identity_resolution",
            "skipped"
          );
        }
        if (parseOnlyResume) {
          await phaseLedger?.transition("warcraft_logs_history", "skipped");
          // A parse-only retry neither scans history nor reads tier bests.
          // Both precede fight parsing in the durable plan and must settle
          // before the first parse request can become active.
          await phaseLedger?.transition("warcraft_logs_tier_bests", "skipped");
        }
        let activePhase: EvidencePhase["id"] | undefined;
        let observedPhase: EvidencePhase["id"] | undefined;
        const phaseLimitations = new Map<EvidencePhase["id"], string>();
        const phaseForQuery = (
          query: WarcraftLogsQueryType
        ): EvidencePhase["id"] =>
          // Attendance recovery is part of the history phase: it reads for the
          // same kills, under the same request cap.
          query === "history_scan" ||
          query === "character_guilds" ||
          query === "guild_attendance" ||
          query === "report_hydration"
            ? "warcraft_logs_history"
            : query === "zone_rankings"
              ? "warcraft_logs_tier_bests"
              : query === "fight_parses"
                ? "warcraft_logs_fight_parses"
                : "warcraft_logs_ranking_identities";
        const observePhase = (query: WarcraftLogsQueryType) => {
          const ledger = phaseLedger;
          const next = phaseForQuery(query);
          if (!ledger || observedPhase === next) return;
          observedPhase = next;
          phaseWrites = phaseWrites.then(async () => {
            if (activePhase) {
              const code = phaseLimitations.get(activePhase);
              await ledger.transition(
                activePhase,
                code ? "limited" : "completed",
                code
              );
            }
            await ledger.transition(next, "active");
            activePhase = next;
          });
        };
        const historyScanResumeOptions =
          storedEvidence.historyScanResumePage &&
          storedEvidence.historyScanResumeBoundaryReportCode
            ? {
                historyScanStartPage: storedEvidence.historyScanResumePage,
                historyScanResumeBoundaryReportCode:
                  storedEvidence.historyScanResumeBoundaryReportCode
              }
            : {};
        // Raider.IO names the kills worth searching guild attendance for, and
        // attendance is read for nothing else. It is asked only when the run
        // scans history in earnest, and never decides the run's status: a
        // lookup that fails skips recovery, and the run is judged by its
        // history scan alone.
        const historicKills = options.raiderio?.getHistoricMythicKills;
        const verified =
          historicKills && (requestCap > 1 || tierCaps !== null)
            ? await scope.time("raiderIoHistoricKills", () =>
                raiderIoVerifiedKills(
                  { getHistoricMythicKills: historicKills },
                  run.key,
                  {
                    storedKills: storedEvidence.kills,
                    ...(killScanFloor ? { killScanFloor } : {}),
                    signal: activeContext.signal
                  }
                )
              )
            : undefined;
        // Null when Raider.IO was not asked, which is not the same as asked
        // and answering with nothing to search.
        record.raiderIoHistoricOutcome = verified
          ? (verified.limitation ?? "evidence")
          : null;
        // A night searched to the end and found empty in the last week is not
        // searched again (#434). A failure to read that memory costs a search,
        // never a kill, so it is not allowed to fail the run.
        const remembered =
          verified &&
          verified.kills.length > 0 &&
          evidence.emptyAttendanceSearches
            ? new Set(
                (
                  await evidence
                    .emptyAttendanceSearches(
                      run.key,
                      new Date(now().getTime() - EMPTY_SEARCH_RECHECK_MS)
                    )
                    .catch(() => [])
                ).map(emptySearchKey)
              )
            : new Set<string>();
        const toSearch = (verified?.kills ?? []).filter(
          (kill) => !remembered.has(emptySearchKey(kill))
        );
        record.verifiedKillsSearched = verified ? toSearch.length : null;
        record.verifiedKillsSkippedEmpty = verified
          ? verified.kills.length - toSearch.length
          : null;
        // The history scan is the first real upstream boundary for a normal
        // collection. Persist it before entering the gateway, rather than
        // after its promise settles: an interrupted long scan is then plainly
        // active, not a run that merely looks queued to readers.
        if (!parseOnlyResume) {
          await phaseLedger?.transition("warcraft_logs_history", "active");
          activePhase = phaseLedger ? "warcraft_logs_history" : undefined;
          observedPhase = activePhase;
        }
        const identities = [run.key, ...historicAliases];
        const aliasProgress = new Map(
          (storedEvidence.historicAliasProgress ?? []).map((progress) => [
            canonicalCharacterId(progress.key),
            progress
          ])
        );
        const turn = tierSearchAsked
          ? 0
          : (storedEvidence.identityScanTurn ?? 0) % identities.length;
        const historyCaps = new Map<number, number>();
        if (historicAliases.length === 0 || tierSearchAsked) {
          // Explicit tier searches belong to the current identity. With no
          // aliases this is also the established parse-only zero-scan path.
          historyCaps.set(0, requestCap);
        } else {
          let available = requestCap;
          for (let offset = 0; offset < identities.length; offset += 1) {
            const index = (turn + offset) % identities.length;
            const progress =
              index === 0
                ? historyScanResumeOptions
                : aliasProgress.get(canonicalCharacterId(identities[index]!));
            // A resumed scan spends one request proving its saved boundary;
            // admitting it with only one repeats the probe forever.
            const minimum = progress?.historyScanResumeBoundaryReportCode
              ? 2
              : 1;
            if (minimum > available) continue;
            historyCaps.set(index, minimum);
            available -= minimum;
          }
          const selected = [...historyCaps.keys()];
          for (
            let extra = 0;
            extra < available && selected.length > 0;
            extra += 1
          ) {
            const index = selected[extra % selected.length]!;
            historyCaps.set(index, historyCaps.get(index)! + 1);
          }
        }
        const parseCapFor = (index: number): number => {
          if (!historyCaps.has(index)) return 0;
          const selected = [...historyCaps.keys()];
          const position = selected.indexOf(index);
          return (
            Math.floor(parseRequestCap / selected.length) +
            (position < parseRequestCap % selected.length ? 1 : 0)
          );
        };
        const deferred = historyCaps.size < identities.length;
        let response: WarcraftLogsReportResult = historyCaps.has(0)
          ? await scope.time("warcraftLogs", () =>
              gateway.getFirstKillReports(run.key, {
                requestCap: historyCaps.get(0)!,
                parseRequestCap: parseCapFor(0),
                ...(run.className ? { className: run.className } : {}),
                hydratedFightUrls,
                collectedTierZones,
                terminalRaidIds:
                  historicAliases.length > 0
                    ? { ...terminalRaidIds, kills: new Set<string>() }
                    : terminalRaidIds,
                ...(historicAliases.length === 0 && killScanFloor
                  ? { killScanFloor }
                  : {}),
                ...(characterId !== undefined ? { characterId } : {}),
                ...(toSearch.length > 0 ? { verifiedKills: toSearch } : {}),
                // From stored evidence on every scanning run, whatever Raider.IO
                // answered: a complete publish keeps only what the run finds again
                // outside terminal raids, so a kill recovered from attendance is
                // re-read rather than dropped.
                ...(requestCap > 1
                  ? {
                      storedKillReportCodes: storedKillReportCodes(
                        [...storedEvidence.kills, ...storedEvidence.wipes],
                        terminalRaidIds.kills
                      )
                    }
                  : {}),
                ...(tierSearchAsked
                  ? {
                      tierSearch: {
                        ...tierWindow,
                        guilds: tierSearchGuilds(
                          verified?.guilds ?? [],
                          storedEvidence.guilds ?? []
                        ),
                        requestCap: tierCaps.tier,
                        // Every stored kill's report: one in a terminal raid is
                        // carried by the publish, and one outside it is re-read.
                        skipReportCodes: storedKillReportCodes(
                          [...storedEvidence.kills, ...storedEvidence.wipes],
                          new Set()
                        )
                      }
                    }
                  : {}),
                ...(tierSearchAsked && tierSearchRaidId && rankedCap > 0
                  ? {
                      rankedBackfill: {
                        journalRaidId: tierSearchRaidId,
                        requestCap: rankedCap,
                        ...(rankedCursor ? { cursor: rankedCursor } : {})
                      }
                    }
                  : {}),
                ...historyScanResumeOptions,
                ...(parseOnlyResume
                  ? {
                      storedKills: (storedEvidence.parseOnlyKills ?? [])
                        .map((kill) => storedKillForParse(kill, run.key.region))
                        .filter(
                          (kill): kill is WarcraftLogsFirstKillEvidence =>
                            kill !== null
                        )
                    }
                  : {}),
                // `warcraftLogsCalls` counts gateway invocations; one of those is
                // four classes of upstream request. Counting them apart is what
                // makes a run's points attributable to the history scan or to
                // rankings, rather than a total nobody can act on (#303).
                onRequest: (event) => {
                  observePhase(event.query);
                  scope.increment(
                    `${REQUEST_COUNTER_PREFIX[event.query]}Requests`
                  );
                  if (event.limited) {
                    scope.increment(
                      `${REQUEST_COUNTER_PREFIX[event.query]}Limited`
                    );
                  }
                  if (event.limitationCode === "schema_drift") {
                    record.limitationQuery = event.query;
                  }
                },
                onLimitation: (query, code) => {
                  if (code === "schema_drift") record.limitationQuery = query;
                  observePhase(query);
                  if (phaseLedger) {
                    const limitedPhase = phaseForQuery(query);
                    phaseLimitations.set(limitedPhase, code);
                  }
                },
                signal: activeContext.signal
              })
            )
          : {
              kind: "limitation",
              code: "request_cap"
            };
        // A former name is collected by name and realm, then its evidence is
        // published under the connected character's key. No alias becomes a
        // separate dossier character or independent evidence run.
        for (const [aliasIndex, alias] of historicAliases.entries()) {
          if (!historyCaps.has(aliasIndex + 1)) continue;
          const previous = aliasProgress.get(canonicalCharacterId(alias));
          const historic = await scope.time("warcraftLogsHistoricAlias", () =>
            gateway.getFirstKillReports(alias, {
              requestCap: historyCaps.get(aliasIndex + 1)!,
              parseRequestCap: parseCapFor(aliasIndex + 1),
              ...(previous?.historyScanResumePage &&
              previous.historyScanResumeBoundaryReportCode
                ? {
                    historyScanStartPage: previous.historyScanResumePage,
                    historyScanResumeBoundaryReportCode:
                      previous.historyScanResumeBoundaryReportCode
                  }
                : {}),
              ...(previous?.pendingParseFightUrls?.length
                ? {
                    storedKills: (storedEvidence.parseOnlyKills ?? [])
                      .filter((kill) =>
                        previous.pendingParseFightUrls!.includes(kill.fightUrl)
                      )
                      .map((kill) => storedKillForParse(kill, run.key.region))
                      .filter(
                        (kill): kill is WarcraftLogsFirstKillEvidence =>
                          kill !== null
                      )
                  }
                : {}),
              ...(run.className ? { className: run.className } : {}),
              hydratedFightUrls,
              collectedTierZones,
              terminalRaidIds: {
                kills: new Set<string>(),
                parses: new Set<string>(),
                tierBests: new Set<string>()
              },
              onRequest: (event) => {
                observePhase(event.query);
                scope.increment(
                  `${REQUEST_COUNTER_PREFIX[event.query]}Requests`
                );
              },
              signal: activeContext.signal
            })
          );
          if (historic.kind === "evidence") {
            const pendingParseFightUrls =
              historic.parseLimitation || historic.parseLimitations?.length
                ? [
                    ...new Set([
                      ...(previous?.pendingParseFightUrls ?? []),
                      ...historic.kills.map((kill) => kill.fightUrl)
                    ])
                  ].filter(
                    (url) =>
                      !historic.parsedFightUrls.includes(url) &&
                      !hydratedFightUrls.has(url)
                  )
                : [];
            const next: HistoricAliasScanProgress = {
              key: alias,
              pendingParseFightUrls,
              ...(historic.historyScanResumePage !== undefined
                ? {
                    historyScanResumePage: historic.historyScanResumePage,
                    ...(historic.historyScanResumeBoundaryReportCode
                      ? {
                          historyScanResumeBoundaryReportCode:
                            historic.historyScanResumeBoundaryReportCode
                        }
                      : {})
                  }
                : historic.limitation
                  ? {
                      ...(previous?.historyScanResumePage
                        ? {
                            historyScanResumePage:
                              previous.historyScanResumePage
                          }
                        : {}),
                      ...(previous?.historyScanResumeBoundaryReportCode
                        ? {
                            historyScanResumeBoundaryReportCode:
                              previous.historyScanResumeBoundaryReportCode
                          }
                        : {})
                    }
                  : {}),
              historyComplete:
                !historic.limitation &&
                historic.historyScanResumePage === undefined,
              parseWorkOutstanding: pendingParseFightUrls.length > 0
            };
            aliasProgress.set(canonicalCharacterId(alias), next);
          }
          response = mergeHistoricAliasResponse(response, historic);
        }
        if (deferred && response.kind === "evidence") {
          response = {
            ...response,
            limitation: response.limitation ?? {
              kind: "limitation",
              code: "request_cap"
            }
          };
        }
        const historicAliasProgress = historicAliases
          .map((alias) => aliasProgress.get(canonicalCharacterId(alias)))
          .filter(
            (item): item is HistoricAliasScanProgress => item !== undefined
          );
        await phaseWrites;
        // Only a search this run asked for is the run's to record.
        if (
          tierSearchAsked &&
          response.kind === "evidence" &&
          response.tierSearch
        ) {
          tierSearchResult = response.tierSearch;
          record.tierSearchOutcome = response.tierSearch.outcome;
          record.tierSearchRecoveredKills = response.tierSearch.recoveredKills;
          record.tierSearchRecoveredWipes = response.tierSearch.recoveredWipes;
        }
        activeContext.signal.throwIfAborted();

        // What the run actually cost. This is the measurement that replaces the
        // guessed reserve with evidence, so it is sampled even when the run was
        // limited. A negative `pointsSpentByRun` means the hourly window reset
        // mid-run; it is logged as observed rather than clamped away.
        // Never at the cost of the collection it is measuring. This is an extra
        // round trip standing between a finished scan and its publish, and the
        // gateway rethrows the abort reason -- a graceful shutdown landing in
        // this window would otherwise discard a run that has already spent its
        // whole request and parse budget.
        await sampleSpend();

        if (response.kind === "limitation") {
          if (activePhase)
            await phaseLedger?.transition(
              activePhase,
              "limited",
              response.code
            );
          await phaseLedger?.skipPending();
          record.outcome = "limitation";
          record.limitationCode = response.code;
          const limitationRetryMs = retryDelayMs(response);
          const retryAfterAt =
            limitationRetryMs === null
              ? undefined
              : new Date(now().getTime() + limitationRetryMs);
          // Empty rather than absent, and it changes nothing either way: a
          // stage carrying a scan limitation settles no tier in any domain,
          // because a scan that went wrong may be missing reports from any.
          await stageAndPublish(
            {
              state: "partial",
              ...(historicAliases.length > 0 ? { historicAliasProgress } : {}),
              ...(storedEvidence.historyScanResumePage !== undefined
                ? {
                    historyScanResumePage: storedEvidence.historyScanResumePage,
                    historyScanResumeBoundaryReportCode:
                      storedEvidence.historyScanResumeBoundaryReportCode ?? null
                  }
                : {}),
              limitationCode: response.code,
              parseLimitationCode: null,
              // The scan stopped before any parse work, so there is nothing
              // to have raised.
              parseLimitationCodesSeen: [],
              ...(retryAfterAt ? { retryAfterAt } : {}),
              kills: [],
              wipes: [],
              tierBests: [],
              cuttingEdges: [],
              // The scan stopped before any parse work, so no fight was
              // asked about.
              parsedFightUrls: [],
              completedAt: now()
            },
            { parses: [], tierBests: [] }
          );
          return;
        }

        // Every parse limitation the read raised, not only the one it happened
        // to report last. Older gateways -- and any response that raised none
        // -- fall back to the single reported code, so this is never empty
        // when there was something to say.
        const parseLimitationsSeen =
          response.parseLimitations ??
          (response.parseLimitation ? [response.parseLimitation] : []);
        // Which of them decides the retry, and so which code the run records.
        // Deliberate policy rather than assignment order: a cap that earns a
        // retry must not be suppressed by a drift that does not (#349).
        const drivingParse = drivingParseLimitation(parseLimitationsSeen, {
          transientRetryMs: options.transientRetryMs,
          capRetryMs: options.capRetryMs
        });
        if (activePhase) {
          const limitationCode =
            phaseLimitations.get(activePhase) ??
            (activePhase === "warcraft_logs_history"
              ? response.limitation?.code
              : undefined);
          await phaseLedger?.transition(
            activePhase,
            limitationCode ? "limited" : "completed",
            limitationCode
          );
        }
        // The remaining providers are part of this run, not dossier-read
        // embellishments. Each phase is entered at its own gateway boundary
        // and terminalised before the next one begins.
        await phaseLedger?.skipPendingBefore("raiderio_rankings");
        const allKills = new Map(
          carriedRankedKills.map((kill) => [kill.fightUrl, kill] as const)
        );
        for (const kill of response.kills) allKills.set(kill.fightUrl, kill);
        const publishedKills = [...allKills.values()].map(
          toCharacterMythicKillInput
        );
        if (options.raiderio) {
          const requests = new Map<string, MythicBossRankingsOptions>();
          for (const kill of publishedKills) {
            const request = raiderIoRankingRequest(kill, run.key.region);
            if (request) requests.set(rankingRequestKey(request), request);
          }
          if (requests.size === 0) {
            await phaseLedger?.transition("raiderio_rankings", "skipped");
          } else {
            await phaseLedger?.transition("raiderio_rankings", "active");
            try {
              const cappedRequests = [...requests.entries()].slice(
                0,
                MAX_RAIDER_IO_RANKING_REQUESTS_PER_RUN
              );
              const results = new Map<string, readonly MythicBossRanking[]>();
              let limitationCode: string | undefined =
                requests.size > cappedRequests.length
                  ? "request_cap"
                  : undefined;
              for (
                let offset = 0;
                offset < cappedRequests.length;
                offset += RAIDER_IO_RANKING_CONCURRENCY
              ) {
                const batch = cappedRequests.slice(
                  offset,
                  offset + RAIDER_IO_RANKING_CONCURRENCY
                );
                const settled = await Promise.all(
                  batch.map(async ([key, request]) => ({
                    key,
                    result: await options.raiderio!.getMythicBossRankings(
                      request,
                      activeContext.signal
                    )
                  }))
                );
                for (const item of settled) {
                  if (item.result.kind === "rankings")
                    results.set(item.key, item.result.rows);
                  else limitationCode ??= item.result.code;
                }
              }
              for (let index = 0; index < publishedKills.length; index += 1) {
                const kill = publishedKills[index]!;
                const request = raiderIoRankingRequest(kill, run.key.region);
                const rows = request
                  ? results.get(rankingRequestKey(request))
                  : undefined;
                if (rows) {
                  publishedKills[index] = {
                    ...kill,
                    historicRankCheckedAt: new Date().toISOString(),
                    historicWorldRank: historicWorldRankForKill(
                      kill,
                      run.key.region,
                      rows
                    )
                  };
                }
              }
              await phaseLedger?.transition(
                "raiderio_rankings",
                limitationCode ? "limited" : "completed",
                limitationCode
              );
            } catch (error) {
              if (activeContext.signal.aborted) throw error;
              await phaseLedger?.transition(
                "raiderio_rankings",
                "limited",
                "unavailable"
              );
            }
          }
        }
        let cuttingEdges: readonly CharacterCuttingEdgeInput[] = [];
        if (options.blizzard) {
          await phaseLedger?.transition("blizzard_achievements", "active");
          try {
            cuttingEdges = (
              await options.blizzard.getCompletedAchievements(
                run.key,
                activeContext.signal
              )
            )
              .filter((achievement) =>
                isAccountWideCuttingEdgeAchievement(achievement.achievementId)
              )
              .map((achievement) => ({
                achievementId: achievement.achievementId,
                completedAt: achievement.completedAt
              }));
            await phaseLedger?.transition("blizzard_achievements", "completed");
          } catch (error) {
            if (activeContext.signal.aborted) throw error;
            await phaseLedger?.transition(
              "blizzard_achievements",
              "limited",
              "unavailable"
            );
          }
        }
        await phaseLedger?.skipPending();
        activeContext.signal.throwIfAborted();
        // Whichever limitation asks to wait longest decides, because the run
        // is not collectable again until both are. A limitation with no answer
        // at all contributes nothing rather than forcing a retry the code was
        // deliberately not given.
        const retryAfterMs = Math.max(
          retryDelayMs(response.limitation) ?? 0,
          retryDelayMs(drivingParse) ?? 0
        );
        // Honest about the run, not just about its history scan: a run that
        // spent its whole parse budget did not finish, and reporting it
        // `complete` was the other half of why the character looked settled.
        const incomplete = Boolean(
          response.limitation ?? drivingParse ?? response.scanSkipped
        );
        record.outcome = incomplete ? "partial" : "complete";
        record.limitationCode = response.limitation?.code ?? null;
        record.parseLimitationCode = drivingParse?.code ?? null;
        record.killCount = publishedKills.length;
        record.attendanceRecoveredKills =
          response.attendanceRecoveredKills ?? null;
        if (response.attendanceSearchedEmpty?.length) {
          // A cache of where not to look, not evidence: losing a write costs
          // one repeated search next run.
          await evidence
            .recordEmptyAttendanceSearches?.(
              run.key,
              response.attendanceSearchedEmpty,
              now()
            )
            .catch(() => undefined);
        }
        await stageAndPublish(
          {
            state: incomplete ? "partial" : "complete",
            ...(historicAliases.length > 0 ? { historicAliasProgress } : {}),
            ...(response.scanSkipped ? { scanSkipped: true } : {}),
            ...(response.rankedBackfillCursor !== undefined
              ? { rankedBackfillCursor: response.rankedBackfillCursor }
              : {}),
            ...(response.scanSkipped
              ? {}
              : response.historyScanResumePage !== undefined
                ? {
                    historyScanResumePage: response.historyScanResumePage,
                    historyScanResumeBoundaryReportCode:
                      response.historyScanResumeBoundaryReportCode ?? null
                  }
                : response.limitation === undefined
                  ? storedEvidence.historyScanResumePage !== undefined
                    ? {
                        historyScanResumePage: null,
                        historyScanResumeBoundaryReportCode: null
                      }
                    : {}
                  : storedEvidence.historyScanResumePage !== undefined
                    ? {
                        historyScanResumePage:
                          storedEvidence.historyScanResumePage,
                        historyScanResumeBoundaryReportCode:
                          storedEvidence.historyScanResumeBoundaryReportCode ??
                          null
                      }
                    : {}),
            limitationCode: response.limitation?.code ?? null,
            parseLimitationCode: drivingParse?.code ?? null,
            parseLimitationCodesSeen: parseLimitationsSeen.map(
              (limitation) => limitation.code
            ),
            ...(retryAfterMs > 0
              ? { retryAfterAt: new Date(now().getTime() + retryAfterMs) }
              : {}),
            kills: publishedKills,
            wipes: response.wipes,
            tierBests: response.tierBests,
            cuttingEdges,
            parsedFightUrls: response.parsedFightUrls,
            completedAt: now()
          },
          response.troubledRaidIds
        );

        // Marked only after publication succeeded. A mark that outlived a
        // failed publish would stop the tier being collected while nothing
        // was stored for it.
        const marks = terminalTiersFrom({
          at: now(),
          settleMs: options.killSettleMs,
          kills: [...allKills.values()],
          scanSkipped: response.scanSkipped === true,
          scanLimitation: response.limitation?.code ?? null,
          troubledRaidIds: response.troubledRaidIds
        });
        record.terminalTierCount = marks.length;
        if (marks.length > 0) {
          await evidence.markTerminalTiers(run.key, marks, now());
        }
      } catch (error) {
        // The gateway can reject after it has emitted progress callbacks.
        // Drain their chain before settling the run so no late write escapes.
        await phaseWrites.catch(() => undefined);
        const aborted = activeContext.signal.aborted;
        if (aborted) await phaseLedger?.cancelActive();
        record.outcome = aborted
          ? "cancelled"
          : isPointsBudgetRefusal(error)
            ? "points_budget_low"
            : "unexpected_error";
        // Recorded for every caught error, not only the unexplained ones: the
        // outcome says which branch was taken, and this says what was thrown
        // to get there. Bounded to an error class and a code-authored
        // identifier -- see `errorFields` -- so no message text reaches a log.
        Object.assign(record, errorFields(error));

        // What this attempt cost is half the decision, so measure it before
        // deciding -- unless the run was cancelled, where the abort would only
        // reject this call too.
        if (
          !aborted &&
          collectionBegan &&
          record.pointsSpentByRun === null &&
          sampleSpend
        ) {
          await sampleSpend();
        }

        const decision = evidenceRetryDecision({
          classification: classifyEvidenceFailure(error, { aborted }),
          attempt: activeContext.attempt,
          maxAttempts: activeContext.maxAttempts,
          pointsSpent: record.pointsSpentByRun as number | null,
          collectionBegan,
          costCeiling: options.retryCostCeiling
        });
        record.retryDecision = decision.action;
        record.retryReason = decision.reason;

        if (decision.action !== "retry" && !aborted)
          await phaseLedger?.failActive("collection_failed");

        // Rethrowing is what schedules the retry. A run this attempt never
        // claimed has nothing to publish onto either way.
        if (decision.action === "retry" || claimedRunId === undefined) {
          throw error;
        }

        // Stopping means publishing what there is rather than abandoning the
        // run: `publish` carries a partial's previous kills, wipes and parses
        // forward, so this can only add. `retryAfterAt` is what keeps the next
        // page read from reserving straight over the top of it.
        const stopped: EvidencePublication = {
          state: "partial",
          limitationCode: "collection_failed",
          parseLimitationCode: null,
          parseLimitationCodesSeen: [],
          retryAfterAt: new Date(now().getTime() + options.failureCooldownMs),
          kills: [],
          wipes: [],
          tierBests: [],
          cuttingEdges: [],
          // Whatever this attempt read is lost with the error that stopped
          // it: the fights it answered are not in hand to be recorded, so
          // they stay eligible and the next attempt asks again.
          parsedFightUrls: [],
          completedAt: now()
        };
        try {
          await evidence.publish(claimedRunId, stopped);
          record.stopDisposition = "published";
        } catch {
          // Publication is itself what is broken -- #290's case, where the
          // guard threw before any query. The run still has to leave the
          // active set, or `reserve` counts it forever and the character never
          // collects again.
          record.stopDisposition = "failed";
          await evidence.fail(claimedRunId, "collection_failed");
        }
      } finally {
        if (options.logger) {
          record.durationMs = Math.max(0, Math.round(monotonic() - observedAt));
          options.logger.info({ ...record, ...scope.totals() });
        }
        if (announced) {
          // Read from `record`, so the announcement and the log can never
          // disagree about how the run ended.
          try {
            await options.evidenceRunNotifier?.finished({
              runId: job.runId,
              region: announced.region,
              realm: announced.realm,
              name: announced.name,
              attempt: activeContext.attempt,
              outcome: record.outcome as string,
              limitationCode: record.limitationCode as string | null,
              parseLimitationCode: record.parseLimitationCode as string | null,
              pointsSpent: record.pointsSpentByRun as number | null,
              ...(record.retryDecision
                ? { retryDecision: record.retryDecision as string }
                : {}),
              retryReason: record.retryReason as string | null
            });
          } catch {
            options.logger?.info({
              event: "evidence_run_announcement_failed",
              runId: job.runId,
              phase: "finished"
            });
          }
        }
        // Last on every path, and skipped outright on an abort. #309 gives a
        // cancelled run a deliberately tight budget to record its outcome
        // before the container goes, and the catch above already spends one
        // database write inside it. A lost cost row costs a sample; a lost
        // outcome costs the run, so this never competes for that window.
        if (claimedRunId !== undefined && !activeContext.signal.aborted) {
          const totals = scope.totals();
          const requests = (field: string) => {
            const value = totals[`${field}Requests`];
            return typeof value === "number" ? value : 0;
          };
          try {
            // `options.evidence`, not the measured wrapper: the totals this
            // would add to have already been logged.
            await options.evidence.recordRunCost({
              runId: claimedRunId,
              attempt: activeContext.attempt,
              outcome: record.outcome as string,
              credentials: usesVisitorCredentials ? "visitor" : "own",
              limitationCode: record.limitationCode as string | null,
              parseLimitationCode: record.parseLimitationCode as string | null,
              // Carried across as they are, nulls included: a null is an
              // allowance that could not be read, and a zero is a run that
              // spent nothing. Collapsing the two would report a cost no run
              // ever had.
              pointsSpent: record.pointsSpentByRun as number | null,
              pointsLimitPerHour: record.pointsLimitPerHour as number | null,
              pointsRemainingBefore: record.pointsRemainingBefore as
                number | null,
              pointsRemainingAfter: record.pointsRemainingAfter as
                number | null,
              requestCapUsed: record.requestCapUsed as number,
              parseRequestCapUsed: record.parseRequestCapUsed as number,
              mode: tierSearchRaidId === undefined ? "full" : "tier_search",
              tierSearch:
                tierSearchRaidId === undefined
                  ? null
                  : {
                      raidId: tierSearchRaidId,
                      outcome:
                        tierSearchResult?.outcome ??
                        (tierSearchStarved ? "request_cap" : null),
                      requests:
                        tierSearchResult?.requests ??
                        (tierSearchStarved ? 0 : null),
                      guilds: tierSearchResult?.guildsSearched ?? null,
                      reportsHydrated:
                        tierSearchResult?.reportsHydrated ?? null,
                      recoveredKills: tierSearchResult?.recoveredKills ?? null,
                      recoveredWipes: tierSearchResult?.recoveredWipes ?? null
                    },
              requests: {
                historyScan: requests(REQUEST_COUNTER_PREFIX.history_scan),
                characterGuilds: requests(
                  REQUEST_COUNTER_PREFIX.character_guilds
                ),
                guildAttendance: requests(
                  REQUEST_COUNTER_PREFIX.guild_attendance
                ),
                reportHydration: requests(
                  REQUEST_COUNTER_PREFIX.report_hydration
                ),
                zoneRankings: requests(REQUEST_COUNTER_PREFIX.zone_rankings),
                fightParses: requests(REQUEST_COUNTER_PREFIX.fight_parses),
                rankingIdentities: requests(
                  REQUEST_COUNTER_PREFIX.ranking_identities
                )
              },
              recovery: {
                raiderIoOutcome: record.raiderIoHistoricOutcome as
                  string | null,
                raiderIoMs:
                  typeof totals.raiderIoHistoricKillsMs === "number"
                    ? Math.round(totals.raiderIoHistoricKillsMs)
                    : null,
                verifiedKillsSearched: record.verifiedKillsSearched as
                  number | null,
                recoveredKills: record.attendanceRecoveredKills as
                  number | null,
                verifiedKillsSkippedEmpty: record.verifiedKillsSkippedEmpty as
                  number | null
              }
            });
          } catch {
            // A measurement that could not be stored is not a run that
            // failed. The `evidence_job` line above still carries the same
            // numbers; only the ability to query them is lost.
            options.logger?.info({
              event: "evidence_run_cost_record_failed",
              runId: job.runId
            });
          }
        }
      }
    }
  };
}

export type ApplicantEvidenceJobHandler = ReturnType<
  typeof createApplicantEvidenceJobHandler
>;
