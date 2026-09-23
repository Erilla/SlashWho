import type {
  DiscoveryRunStatus,
  PublicErrorCode,
  SnapshotState
} from "@slashwho/contracts";
import type { CharacterGuild, CharacterKey } from "@slashwho/domain";

export type CallerClass = "anonymous" | "bot";
export type EvidenceRunStatus =
  "queued" | "running" | "retrying" | "complete" | "partial" | "failed";
export type DiscoverySource =
  "input" | "claimed" | "declared_main" | "profile_guess" | "fingerprint";

export interface DiscoveryRun {
  id: string;
  rootKey: CharacterKey;
  rootCharacterId: string | null;
  queueJobId: string | null;
  status: DiscoveryRunStatus;
  callerClass: CallerClass;
  attempt: number;
  nextRetryAt: Date | null;
  errorCode: PublicErrorCode | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  snapshotId: string | null;
}

export interface SnapshotCharacterInput {
  key: CharacterKey;
  displayName: string;
  className: string;
  level: number;
  /** The guild as at this snapshot, or null when guildless or unknown. */
  guild: CharacterGuild | null;
  raiderIoUrl: string;
  source: DiscoverySource;
}

export interface StoredSnapshotCharacter extends SnapshotCharacterInput {
  characterId: string;
  displayOrder: number;
}

export interface StoredSnapshot {
  id: string;
  runId: string;
  rootKey: CharacterKey;
  state: SnapshotState;
  limitationCode: string | null;
  refreshedAt: Date;
  characterCount: number;
  characters: StoredSnapshotCharacter[];
}

export interface CreateSnapshotInput {
  runId: string;
  rootKey: CharacterKey;
  state: SnapshotState;
  limitationCode: string | null;
  refreshedAt: Date;
  characters: SnapshotCharacterInput[];
}

export interface SnapshotHistoryItem {
  id: string;
  refreshedAt: Date;
  state: SnapshotState;
  characterCount: number;
}

export interface SnapshotHistoryPage {
  items: SnapshotHistoryItem[];
  nextCursor: string | null;
}

export interface FingerprintSweepCursor {
  /** Canonical id of the last candidate swept, or null to seal the sweep. */
  resumeAfter: string | null;
  /**
   * The Raider.IO limitation observed by the run that started this sweep.
   * `snapshots.limitation_code` is overwritten with `fingerprint_sweep_capped`
   * while the chain runs, so this is the only surviving copy and it is what the
   * sealing cycle restores.
   */
  limitationCode: string | null;
  /**
   * Region-qualified public guild observations frozen when the sweep begins.
   * They are carried through continuations so a later evidence refresh cannot
   * turn this one-hop sweep into an expanding graph traversal.
   */
  historicalGuilds?: readonly CharacterGuild[];
  /**
   * True when this cycle moved the sweep forward -- it swept at least one new
   * candidate, or it exhausted the roster. False only for a cycle that swept
   * nothing new (the budget ran out before the first candidate), which is what
   * distinguishes a stuck chain from a slow one: `continuation_failures` is
   * reset on progress and preserved otherwise.
   */
  advanced: boolean;
}

/** The next admission a capped sweep persists atomically with its cursor. */
export type FingerprintContinuationAdmission = Readonly<{
  requestCap: number;
  hourlyBudget: number;
  cadenceCutoff: Date;
}>;

export interface SnapshotRepository {
  create(
    input: CreateSnapshotInput,
    options?: { signal?: AbortSignal }
  ): Promise<StoredSnapshot>;
  createAndFinishFingerprintSweep(
    input: CreateSnapshotInput,
    fingerprint: {
      reservationId: string;
      finishedAt: Date;
      limitationCode: string | null;
      continuationAdmission?: FingerprintContinuationAdmission;
    },
    cursor: FingerprintSweepCursor,
    options?: { signal?: AbortSignal }
  ): Promise<StoredSnapshot>;
  /**
   * Appends fingerprint matches to a snapshot already published by an earlier
   * cycle of the same sweep. Never touches `discovery_runs`: the run that
   * published the snapshot is already complete.
   *
   * Returns `null` without writing anything when `runId` no longer owns the
   * cursor -- the stored `resume_snapshot_id` has moved on, or the snapshot
   * belongs to another run. Ownership is re-checked under the root lock, so a
   * fresh refresh that publishes concurrently discards this continuation
   * instead of having its own cursor overwritten by a dead one.
   */
  amendAndFinishFingerprintSweep(
    snapshotId: string,
    characters: SnapshotCharacterInput[],
    fingerprint: {
      /** The run that must still own the cursor for this amend to apply. */
      runId: string;
      reservationId: string;
      finishedAt: Date;
      limitationCode: string | null;
      continuationAdmission?: FingerprintContinuationAdmission;
    },
    cursor: FingerprintSweepCursor,
    options?: { signal?: AbortSignal }
  ): Promise<StoredSnapshot | null>;
  getCurrent(key: CharacterKey): Promise<StoredSnapshot | null>;
  getCurrentContainingCharacter?(
    key: CharacterKey
  ): Promise<StoredSnapshot | null>;
  /**
   * Characters whose current snapshot stores this key as their direct declared
   * main. Only the first declared-main membership is direct (later ones are a
   * forward chain), and only the latest completed snapshot per declaring root
   * contributes, so a later observation that omits the edge retires it.
   */
  listReverseDeclaredCharacters(
    key: CharacterKey
  ): Promise<readonly SnapshotCharacterInput[]>;
  find(id: string): Promise<StoredSnapshot | null>;
  listHistory(
    key: CharacterKey,
    page: { cursor: string | null; limit: number }
  ): Promise<SnapshotHistoryPage>;
}

/**
 * A manually connected character. It is stored by key, so it can be linked
 * before discovery has created its row: until then the upstream details are
 * unknown and `pending` is true, rather than a placeholder class and level
 * being invented for it.
 */
export interface ManualConnectionCharacter {
  key: CharacterKey;
  displayName: string;
  className: string | null;
  level: number;
  raiderIoUrl: string;
  pending: boolean;
  /** A reviewer has hidden this character from the dossier evidence. */
  excluded: boolean;
}

export interface ManualConnectionRepository {
  /** Exclusions for snapshot-discovered characters; manual links keep their flag. */
  listDiscoveredExclusions?(
    root: CharacterKey
  ): Promise<readonly CharacterKey[]>;
  setDiscoveredExcluded?(
    root: CharacterKey,
    character: CharacterKey,
    excluded: boolean
  ): Promise<"updated" | "missing">;
  list(root: CharacterKey): Promise<readonly ManualConnectionCharacter[]>;
  add(
    root: CharacterKey,
    character: CharacterKey
  ): Promise<"added" | "duplicate">;
  /**
   * Hides the character from the dossier evidence, or restores it. Reports a
   * connection that is no longer linked rather than reporting a change it did
   * not make: two reviewers can hold the same dossier at once.
   */
  setExcluded(
    root: CharacterKey,
    character: CharacterKey,
    excluded: boolean
  ): Promise<"updated" | "missing">;
  remove(
    root: CharacterKey,
    character: CharacterKey
  ): Promise<"removed" | "missing">;
}

export interface SuppressionRepository {
  suppress(
    key: CharacterKey,
    reason: string,
    expiresAt: Date | null
  ): Promise<void>;
  isActive(key: CharacterKey, at?: Date): Promise<boolean>;
  cleanupExpired(at?: Date): Promise<number>;
}

export interface RateLimitRepository {
  reserve(
    callerBucketHash: string,
    limit: number,
    expiresAt: Date,
    at?: Date
  ): Promise<{ allowed: boolean; retryAt: Date | null }>;
  record(callerBucketHash: string, expiresAt: Date): Promise<void>;
  countActive(callerBucketHash: string, at?: Date): Promise<number>;
  cleanupExpired(at?: Date): Promise<number>;
}

export interface NegativeCacheEntry {
  key: CharacterKey;
  expiresAt: Date;
}

export interface NegativeCacheRepository {
  put(key: CharacterKey, expiresAt: Date): Promise<void>;
  putAndFailRun(
    key: CharacterKey,
    expiresAt: Date,
    runId: string,
    options?: { signal?: AbortSignal }
  ): Promise<void>;
  find(key: CharacterKey, at?: Date): Promise<NegativeCacheEntry | null>;
  cleanupExpired(at?: Date): Promise<number>;
}

export interface CharacterEvidenceRun {
  id: string;
  key: CharacterKey;
  queueJobId: string | null;
  status: EvidenceRunStatus;
  attempt: number;
  limitationCode: string | null;
  parseLimitationCode: string | null;
  retryAfterAt: Date | null;
  errorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  wclClientIdEncrypted: string | null;
  wclClientSecretEncrypted: string | null;
  /** The character's class, carried so evidence collection can resolve shared specialisation names. */
  className: string | null;
  /** What the run was reserved to do; see `EvidenceRunMode`. */
  mode: EvidenceRunMode;
  /** The Journal raid id a `tier_search` run searches, and null otherwise. */
  tierSearchRaidId: string | null;
}

/**
 * `full` is every collection there has always been. `tier_search` is a full
 * collection that also walks one tier's guild attendance, reserved only by an
 * explicit request from the dossier (#435) and never by a read, a resume or a
 * retry.
 */
export type EvidenceRunMode = "full" | "tier_search";

/**
 * Why a tier search was or was not reserved. `recent` is the per-tier,
 * per-character rate limit; `no_evidence` means there is nothing yet to add
 * to, so an ordinary collection has to come first.
 */
/** The newest tier search of one raid for a character, for the dossier. */
export type LatestTierSearch = Readonly<{
  /** The Journal raid id the search was asked for. */
  raidId: string;
  status: EvidenceRunStatus;
  createdAt: Date;
}>;

export type TierSearchReservationResult =
  | { kind: "reserved"; run: CharacterEvidenceRun }
  | { kind: "active"; run: CharacterEvidenceRun }
  | { kind: "recent"; run: CharacterEvidenceRun }
  | { kind: "no_evidence" };

/**
 * The deliberately narrow evidence-run projection available to the operator
 * monitor. Run ids, queue ids, collection payloads, costs, and encrypted
 * visitor credentials are not part of this boundary.
 */
export type EvidenceMonitorRun = Readonly<{
  key: CharacterKey;
  status: EvidenceRunStatus;
  evidenceVersion: number;
  attempt: number;
  limitationCode: string | null;
  parseLimitationCode: string | null;
  retryAfterAt: Date | null;
  errorCode: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}>;

/** A privacy-safe operational projection; provider payloads never enter it. */
export type EvidenceRunPhase = Readonly<{
  id: string;
  ordinal: number;
  state:
    | "pending"
    | "active"
    | "completed"
    | "skipped"
    | "limited"
    | "failed"
    | "cancelled";
  startedAt: Date | null;
  completedAt: Date | null;
  limitationCode: string | null;
}>;

export type CharacterMythicKillParseMetric =
  | Readonly<{ state: "available"; percentile: number }>
  | Readonly<{ state: "not_applicable" | "unavailable" }>;

export type CharacterMythicKillPerformance = Readonly<{
  spec?: Readonly<{ name: string; iconUrl: string }> | null;
  damage: CharacterMythicKillParseMetric;
  healing: CharacterMythicKillParseMetric;
  bossDamage: CharacterMythicKillParseMetric;
}>;

export interface CharacterMythicKillInput {
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  journalBossId: string | null;
  bossOrder: number;
  killedAt: string;
  reportUrl: string;
  fightUrl: string;
  /** Region is absent only on evidence stored before report guild regions. */
  guild: {
    name: string;
    realm: string;
    region?: CharacterKey["region"];
  } | null;
  /** Absent on evidence collected before Warcraft Logs exposed report owners. */
  uploader?: string | null;
  /** Raider.IO's confirmed world rank for this kill, if available. */
  historicWorldRank?: number | null;
  /** A successful ranking response, including one with no unique match. */
  historicRankCheckedAt?: string | null;
  performance: CharacterMythicKillPerformance;
}

export interface StoredCharacterMythicKill extends CharacterMythicKillInput {
  id: string;
  /**
   * ISO 8601 of when this fight's rankings were last asked about and
   * answered, or null if they never have been. An answer of "no ranking" is
   * still an answer, so this is not derivable from the parse states.
   */
  parsesReadAt: string | null;
}

/**
 * A character's best Mythic parse for one encounter of one raid zone. It is a
 * claim about the character's history rather than about any stored kill, so it
 * carries a rankings link instead of a fight link and is keyed by encounter
 * rather than by fight.
 */
export interface CharacterTierBestParseInput {
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  rankingsUrl: string;
  performance: CharacterMythicKillPerformance;
}

export interface StoredCharacterTierBestParse extends CharacterTierBestParseInput {
  id: string;
}

export interface CharacterMythicWipeInput {
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  journalBossId: string | null;
  bossOrder: number;
  attemptedAt: string;
  reportUrl: string;
  fightUrl: string;
  /** Absent on evidence collected before report provenance was stored. */
  guild?: { name: string; realm: string } | null;
  /** Absent on evidence collected before Warcraft Logs exposed report owners. */
  uploader?: string | null;
}

export interface StoredCharacterMythicWipe extends CharacterMythicWipeInput {
  id: string;
}

export type CharacterCuttingEdgeInput = Readonly<{
  achievementId: string;
  completedAt: string;
}>;

export interface CompletedCharacterEvidence {
  run: CharacterEvidenceRun;
  /** Internal cache generation used to invalidate evidence after a parser fix. */
  evidenceVersion?: number;
  kills: readonly StoredCharacterMythicKill[];
  wipes: readonly StoredCharacterMythicWipe[];
  tierBests: readonly StoredCharacterTierBestParse[];
  cuttingEdges: readonly CharacterCuttingEdgeInput[];
  /** True only when this run completed its Blizzard achievement phase. */
  cuttingEdgesCollected?: boolean;
  wipeCapable: boolean;
}

/**
 * `kind` answers "is the stored evidence usable" and `active` answers "is a
 * collection running" -- two independent questions. A refresh deliberately
 * forces a run past the freshness window, so fresh evidence and an in-flight
 * run coexist; a reader that infers one from the other reports a refresh it
 * started as no work at all.
 */
export type EvidenceReservationResult =
  | {
      kind: "fresh";
      run: CharacterEvidenceRun;
      completed: CompletedCharacterEvidence;
      /** An in-flight run collecting over this already-fresh evidence. */
      active: CharacterEvidenceRun | null;
    }
  | {
      kind: "active";
      run: CharacterEvidenceRun;
      completed: CompletedCharacterEvidence | null;
      /** Always the joined run -- the same value as `run`. */
      active: CharacterEvidenceRun;
    }
  | {
      kind: "reserved";
      run: CharacterEvidenceRun;
      completed: CompletedCharacterEvidence | null;
      /** Always the run this call created -- the same value as `run`. */
      active: CharacterEvidenceRun;
    };

/**
 * The parts of a character's Warcraft Logs evidence that settle independently,
 * so a collection fix can re-collect one without disturbing the others.
 */
export type EvidenceCollectionDomain = "kills" | "parses" | "tier_bests";

/** A verified kill whose night was searched to the end and held nothing. */
export type EmptyAttendanceSearch = Readonly<{
  /** Raider.IO's first-defeated time, as an ISO string. */
  at: string;
  guild: Readonly<{ name: string; realm: string; region: string }>;
}>;

/** Where and when one stored kill happened, without its evidence. */
export type StoredKillTier = Readonly<{
  raidId: string;
  raidName: string;
  killedAt: string;
  /**
   * The report the kill came from, so a kill the character's own history
   * does not list can be re-read directly rather than searched for again.
   */
  reportUrl?: string;
}>;

/** A guild stored evidence places the character in. */
export type StoredEvidenceGuild = Readonly<{
  name: string;
  realm: string;
  region: CharacterKey["region"];
}>;

/** Where and when one stored wipe happened, without its evidence. */
export type StoredWipeTier = Readonly<{
  raidId: string;
  /**
   * Carried so the scan floor can tell a raid zone from one it knows is not a
   * raid. A wipe in a Mythic dungeon held the floor down exactly as a kill in
   * one did (#346).
   */
  raidName: string;
  attemptedAt: string;
  /**
   * The report the wipe came from, so a wipe found through guild attendance,
   * absent from the character's own history, can be re-read rather than
   * dropped by the next complete publish.
   */
  reportUrl?: string;
}>;

/**
 * Everything a character holds that a complete publish would drop if the scan
 * stopped above it. Kills and wipes travel together because the publish keeps
 * them on the same condition.
 */
export type StoredEvidenceTiers = Readonly<{
  kills: readonly StoredKillTier[];
  wipes: readonly StoredWipeTier[];
  /**
   * The guilds the stored kills were in, as places a tier search walks
   * attendance for. Absent from an implementation that does not know them.
   */
  guilds?: readonly StoredEvidenceGuild[];
  /** When the last complete history scan was published, if known. */
  lastCleanKillScanAt?: string;
  /**
   * The first page below a capped prefix that decoded cleanly. Absent means
   * either no capped scan has published one, or a later clean scan completed.
   */
  historyScanResumePage?: number;
  /** The final report code on the stored boundary page, used to validate its offset. */
  historyScanResumeBoundaryReportCode?: string;
  /** Cursor and parse state for each former identity, carried by a published run. */
  historicAliasProgress?: readonly HistoricAliasScanProgress[];
  /** Rotates scarce history requests fairly across the current name and aliases. */
  identityScanTurn?: number;
  rankedBackfillCursor?: StoredRankedBackfillCursor;
  /**
   * Whether the newest completed run established that its only unfinished
   * collection work was parses. Absent is conservative: it does not license
   * skipping a scan.
   */
  parseWorkOutstanding?: boolean;
  parseOnlyKills?: readonly CharacterMythicKillInput[];
}>;

export type HistoricAliasScanProgress = Readonly<{
  key: CharacterKey;
  historyScanResumePage?: number;
  historyScanResumeBoundaryReportCode?: string;
  historyComplete?: boolean;
  parseWorkOutstanding?: boolean;
  /** Alias fights awaiting rankings after a capped parse pass. */
  pendingParseFightUrls?: readonly string[];
}>;

/** JSON cursor for an explicit tier's ranked report walk. */
export type StoredRankedBackfillCursor = Readonly<{
  journalRaidId: string;
  characterId?: number;
  zoneIds: readonly number[];
  partitionIds?: readonly number[];
  acceptedFightKeys?: readonly string[];
  zonesLoaded: boolean;
  zoneIndex: number;
  encounterIds: readonly number[];
  encountersLoaded: boolean;
  encounterIndex: number;
  metricIndex: number;
  reportIndex: number;
}>;

/** One raid a character is finished collecting one domain of evidence for. */
export type TerminalTier = Readonly<{
  /** The Warcraft Logs zone id, as carried on the character's stored kills. */
  raidId: string;
  domain: EvidenceCollectionDomain;
}>;

/**
 * One run's collected evidence, held between a finished Warcraft Logs scan and
 * a successful publication. Timestamps are ISO strings because this crosses a
 * JSON boundary; everything else is the publication input verbatim.
 *
 * Normalised gateway facts only. Never credentials.
 */
export interface StagedEvidenceCollection {
  state: "complete" | "partial";
  scanSkipped?: boolean;
  /**
   * Updates the stored history cursor: a page number resumes below a proved
   * prefix; null clears it after a clean full scan; absent preserves it.
   */
  historyScanResumePage?: number | null;
  historyScanResumeBoundaryReportCode?: string | null;
  historicAliasProgress?: readonly HistoricAliasScanProgress[];
  rankedBackfillCursor?: StoredRankedBackfillCursor | null;
  limitationCode: string | null;
  parseLimitationCode: string | null;
  /**
   * Every distinct parse limitation the run raised. Optional because a stage
   * written before #349 does not carry it.
   */
  parseLimitationCodesSeen?: readonly string[];
  /** ISO 8601, or null when the publication carries no retry hint. */
  retryAfterAt: string | null;
  kills: readonly CharacterMythicKillInput[];
  wipes: readonly CharacterMythicWipeInput[];
  tierBests: readonly CharacterTierBestParseInput[];
  /** Blizzard cutting-edge facts collected with this run. */
  cuttingEdges?: readonly CharacterCuttingEdgeInput[];
  /**
   * Fight URLs the run got a ranking answer about, so a republished stage
   * records the attempts it paid for rather than making the next run pay
   * again. Optional because a stage written before this field existed is
   * still republishable; absent means no attempt is recorded, which costs a
   * request and nothing else.
   */
  parsedFightUrls?: readonly string[];
  /** ISO 8601. */
  completedAt: string;
  /**
   * Raids the run attributed a parse-domain limitation to, which is the one
   * input terminal marking needs that no other column records. Without it a
   * republished stage stores evidence but settles nothing, and the character
   * re-pays for zones and scan pages it had already earned the right to stop
   * re-querying.
   *
   * Optional because stages written before this field existed are still
   * republishable. **Absent is not the same as empty**: a stage that cannot
   * say which raids it had trouble with settles nothing at all, because
   * reading its silence as "none" would mark a troubled raid terminal and
   * freeze the parse gaps that trouble was raised to keep open.
   */
  troubledRaidIds?: Readonly<{
    parses: readonly string[];
    tierBests: readonly string[];
  }>;
}

/**
 * What one attempt of an evidence run spent, and the configuration it spent it
 * under. Written once per attempt, from the same record the `evidence_job` log
 * line is built from, so the table and the log can never disagree.
 */
export type EvidenceRunCost = Readonly<{
  runId: string;
  attempt: number;
  /** How the attempt ended, as `evidence_job` names it. */
  outcome: string;
  /** Whose allowance was spent, as the class the budget arithmetic branches on. */
  credentials: "own" | "visitor";
  limitationCode: string | null;
  parseLimitationCode: string | null;
  /**
   * The spend readings, each null when the allowance could not be read. Null
   * is `unavailable`; it is never collapsed into a zero, which is a legitimate
   * reading of a run that spent nothing.
   */
  pointsSpent: number | null;
  pointsLimitPerHour: number | null;
  pointsRemainingBefore: number | null;
  pointsRemainingAfter: number | null;
  /** The caps the run was given, which since #320 are not the configured ones. */
  requestCapUsed: number;
  parseRequestCapUsed: number;
  /** Upstream requests by class, as the log line counts them. */
  /** The run's mode; absent is `full`. */
  mode?: EvidenceRunMode;
  requests: Readonly<{
    historyScan: number;
    /** Absent is zero: only a tier search reads it. */
    characterGuilds?: number;
    guildAttendance: number;
    reportHydration: number;
    zoneRankings: number;
    fightParses: number;
    rankingIdentities: number;
  }>;
  /**
   * What attendance recovery was asked to do and what it yielded, so its cost
   * can be weighed against its return. Each is null when that step did not
   * run, which is not a zero: a Raider.IO lookup not made is not one that
   * found nothing to search.
   */
  recovery: Readonly<{
    /** `evidence`, or the limitation Raider.IO answered with. */
    raiderIoOutcome: string | null;
    raiderIoMs: number | null;
    verifiedKillsSearched: number | null;
    /** Kills not searched for because a recent search found them empty. */
    verifiedKillsSkippedEmpty: number | null;
    recoveredKills: number | null;
  }>;
  /**
   * What a tier search was asked for and what it yielded. Absent or null on a
   * run that searched no tier; its fields are null when the search itself
   * never ran, never zero.
   */
  tierSearch?: Readonly<{
    raidId: string;
    outcome: string | null;
    requests: number | null;
    guilds: number | null;
    reportsHydrated: number | null;
    recoveredKills: number | null;
    recoveredWipes: number | null;
  }> | null;
}>;

export interface EvidenceRepository {
  /** Reviewer-declared former identities of this connected character. */
  historicAliases?(key: CharacterKey): Promise<readonly CharacterKey[]>;
  addHistoricAlias?(
    key: CharacterKey,
    alias: CharacterKey
  ): Promise<"added" | "duplicate" | "missing">;
  removeHistoricAlias?(
    key: CharacterKey,
    alias: CharacterKey
  ): Promise<"removed" | "missing">;
  reserve(input: {
    key: CharacterKey;
    freshnessCutoff: Date;
    at: Date;
    /** The ordered collection plan fixed when a new run is reserved. */
    phasePlan?: readonly string[];
    credentials?: {
      wclClientIdEncrypted: string;
      wclClientSecretEncrypted: string;
    } | null;
  }): Promise<EvidenceReservationResult>;
  /**
   * Reserves a tier search, under the same per-character lock as `reserve`.
   * Nothing else reserves one, so it never becomes a default or a retry path.
   * A search of the same tier created at or after `searchedSince` refuses it
   * as `recent`, and an in-flight run of any mode as `active`.
   */
  /**
   * Each raid's newest tier search for the character created at or after
   * `since`, so the dossier can say whether a tier's search is queued,
   * running or done without a request per tier.
   */
  latestTierSearches(
    key: CharacterKey,
    since: Date
  ): Promise<readonly LatestTierSearch[]>;
  reserveTierSearch(input: {
    key: CharacterKey;
    raidId: string;
    at: Date;
    searchedSince: Date;
    phasePlan?: readonly string[];
  }): Promise<TierSearchReservationResult>;
  find(id: string): Promise<CharacterEvidenceRun | null>;
  claim(id: string, attempt: number): Promise<CharacterEvidenceRun | null>;
  markEnqueued(id: string, queueJobId: string): Promise<void>;
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
    input: {
      scanSkipped?: boolean;
      historyScanResumePage?: number | null;
      historyScanResumeBoundaryReportCode?: string | null;
      historicAliasProgress?: readonly HistoricAliasScanProgress[];
      rankedBackfillCursor?: StoredRankedBackfillCursor | null;
      state: "complete" | "partial";
      limitationCode: string | null;
      /** The parse limitation the run is judged by: retry, and the dossier. */
      parseLimitationCode: string | null;
      /**
       * Every distinct parse limitation the run raised, recorded so one that
       * lost the judgement is still visible afterwards (#349). Optional here
       * and required on `EvidencePublication`: the handler that knows the
       * whole list must not forget it, while a caller that only ever had the
       * one code should not have to restate it.
       */
      parseLimitationCodesSeen?: readonly string[];
      retryAfterAt?: Date | null;
      kills: readonly CharacterMythicKillInput[];
      wipes: readonly CharacterMythicWipeInput[];
      /**
       * Zones this run actually read. The budget covers only a few tiers per
       * run, so the ones it did not reach are carried forward from the
       * character's previous evidence rather than written back blank.
       */
      tierBests: readonly CharacterTierBestParseInput[];
      cuttingEdges?: readonly CharacterCuttingEdgeInput[];
      /**
       * Fight URLs this run asked about and got an answer for, whatever the
       * answer was. Stamped onto those kills so a later run can tell them
       * from fights nothing has ever requested (#297); every other kill keeps
       * whatever it was last stamped with.
       *
       * Optional, and absent safely means empty here: a publication that
       * cannot say what it read simply records no attempt, and the fights are
       * asked about again. That is the behaviour that predates this field, so
       * it costs a request rather than correctness -- unlike
       * `troubledRaidIds`, where reading silence as "none" would settle a
       * tier that was never cleanly read.
       */
      parsedFightUrls?: readonly string[];
      completedAt: Date;
    }
  ): Promise<void>;
  fail(id: string, code: string): Promise<void>;
  /**
   * Holds a finished collection so a retry republishes it rather than paying
   * for the scan again (#292). Overwrites any stage the run already has: the
   * newest scan is the one the publication will use.
   */
  stageCollection(
    runId: string,
    payload: StagedEvidenceCollection
  ): Promise<void>;
  /**
   * The stage `stageCollection` wrote, if this run still has one. `publish`
   * deletes it in the same transaction, so a stage always means a collection
   * that has been paid for upstream and not yet stored.
   */
  stagedCollection(runId: string): Promise<StagedEvidenceCollection | null>;
  /**
   * Drops stages belonging to runs that are no longer active, for a run whose
   * job never reached a publication. Returns the number of rows removed.
   */
  clearSettledCollectionStages(): Promise<number>;
  getCompleted(key: CharacterKey): Promise<CompletedCharacterEvidence | null>;
  /** Records a successful legacy rank fallback on the published kill itself. */
  recordHistoricRankLookup(
    killId: string,
    rank: number | null,
    checkedAt: Date
  ): Promise<void>;
  /**
   * Fight URLs there is nothing left to ask about, so a budget-limited
   * collection run can spend its requests on what is missing instead of
   * redoing the same reports every time.
   *
   * That is a fight carrying at least one available parse metric, or one
   * whose rankings were asked about and answered with nothing. The second
   * half is not decoration: roughly half of hydrated fights return no
   * ranking, and without the attempt recorded they look exactly like fights
   * never requested, so every run re-reads them ahead of anything new (#297).
   *
   * A fight killed at or after `settledBefore` is excluded however well
   * hydrated it is: its rankings are still moving, so treating it as done
   * would freeze a percentile we have reason to believe is not final yet.
   *
   * Scoped to the evidence `getCompleted` returns, so this can never skip a
   * fight the dossier shows blank.
   */
  hydratedFightUrls(
    key: CharacterKey,
    settledBefore: Date
  ): Promise<readonly string[]>;
  /**
   * When each zone's tier best parses were last collected, as
   * `[raidId, completedAt]` pairs. A collection run drops a zone collected
   * since its newest kill before it measures its zone budget, so a saturated
   * character stops raising `parse_request_cap` and the budget reaches the
   * deeper tiers the newest ones were displacing.
   *
   * Scoped like `hydratedFightUrls`, to the evidence `getCompleted` returns.
   */
  collectedTierZones(
    key: CharacterKey
  ): Promise<readonly (readonly [string, string])[]>;
  /**
   * The raid tiers this character is finished with, at or above the current
   * collection version for their own domain. A mark below it is omitted, which
   * is how bumping one domain's version re-collects that domain and leaves the
   * rest settled.
   */
  /**
   * The raid and time of every stored kill and wipe. This is what turns a
   * terminal raid id into a date the report scan can stop at: the marks carry
   * Warcraft Logs zone ids, and only the evidence says when that zone was
   * raided. Wipes are included because a complete publish drops them on the
   * same condition it drops kills, so a floor blind to them skips evidence
   * nothing carries forward (#326).
   *
   * Scoped like `hydratedFightUrls`, to the evidence `getCompleted` returns.
   */
  storedEvidenceTiers(
    key: CharacterKey,
    tierSearchRaidId?: string
  ): Promise<StoredEvidenceTiers>;
  terminalTiers(key: CharacterKey): Promise<readonly TerminalTier[]>;
  /**
   * Records tiers as terminal, stamping each with its domain's current
   * collection version. Idempotent: a run that re-reads an already-settled
   * tier refreshes the mark rather than failing on the primary key.
   */
  markTerminalTiers(
    key: CharacterKey,
    tiers: readonly TerminalTier[],
    at: Date
  ): Promise<void>;
  /**
   * Forgets every terminal mark for one character, so its history is collected
   * again over as many runs as the budget allows. Deletes no evidence: the
   * stored kills, wipes and tier bests stay readable until their replacements
   * arrive. Returns the number of marks forgotten.
   */
  clearTerminalTiers(key: CharacterKey): Promise<number>;
  /**
   * Records the stable Warcraft Logs character ID a key resolved to, replacing
   * any earlier answer: a released name can come to belong to somebody else.
   * Rejects an ID that is not a positive integer.
   */
  recordWarcraftLogsCharacterId(
    key: CharacterKey,
    characterId: number,
    at: Date
  ): Promise<void>;
  /** The Warcraft Logs character ID a key last resolved to, if any. */
  warcraftLogsCharacterId(key: CharacterKey): Promise<number | null>;
  /**
   * Verified kills whose night an attendance search covered to the end and
   * found empty, searched at or after `searchedSince` and at the current kill
   * collection version (#434).
   */
  emptyAttendanceSearches(
    key: CharacterKey,
    searchedSince: Date
  ): Promise<readonly EmptyAttendanceSearch[]>;
  /** Records searches that came up empty; a repeat refreshes `searched_at`. */
  recordEmptyAttendanceSearches(
    key: CharacterKey,
    searches: readonly EmptyAttendanceSearch[],
    at: Date
  ): Promise<void>;
  /**
   * Characters whose last completed run asked to be resumed and whose deadline
   * has passed, oldest deadline first, with nothing already in flight for them.
   *
   * This is what a background sweep drives, because `reserve` is otherwise
   * only reached from a dossier read: a run that set `retry_after_at` became
   * *eligible* to resume and nothing made it happen, so collection continued
   * only when somebody happened to load the page.
   *
   * Deliberately narrower than `reserve`'s own staleness rule, which also
   * hands back evidence that is merely older than the freshness window.
   * Sweeping those too would turn this into a background re-collection of
   * every character ever seen; they are re-collected when read, as before.
   * This returns only characters that asked to be resumed.
   */
  listResumable(limit: number, at: Date): Promise<readonly CharacterKey[]>;
  listStatus(keys: readonly CharacterKey[]): Promise<CharacterEvidenceRun[]>;
  /**
   * Records a limitation on a run that is still active, without publishing
   * anything. A points-budget refusal collects nothing and publishes nothing,
   * so this is the only way the reason a dossier is waiting reaches a reader.
   * `claim` clears it, so it never outlives the attempt that recorded it.
   */
  recordLimitation(runId: string, code: string): Promise<void>;
  /**
   * Clears any lingering encrypted WCL credential columns from evidence runs.
   * `publish` and `fail` already clear these columns on every normal
   * completion path; this is the backstop for a run whose job never reaches
   * either (a crash, a timeout, a killed process between `claim()` and
   * `publish()`/`fail()`), so ciphertext never outlives the run by more than
   * the retention window. Returns the number of rows cleared.
   *
   * Two cutoffs, because a still-active run may legitimately be waiting: a
   * points-budget refusal defers it for up to five attempts of 1800 seconds.
   * Stripping its credentials mid-flight would not fail the run -- it would
   * silently fall back to the worker's shared account and spend the wrong
   * allowance on a visitor's dossier. `active` must therefore outlive the
   * longest deferral chain; `settled` applies to everything else.
   */
  clearStaleCredentials(cutoffs: {
    settled: Date;
    active: Date;
  }): Promise<number>;
  /** Every persisted run, projected only to the fields the operator monitor displays. */
  listForMonitor(): Promise<readonly EvidenceMonitorRun[]>;
  /**
   * Every run `reserve` currently counts as active, oldest first, with the two
   * facts recovery judges them by: the job they were sent to, and when a
   * worker claimed them. A null `queueJobId` is a run reserved but not yet
   * enqueued -- possibly milliseconds old, because `reserve` inserts the row
   * before `enqueue` returns an id.
   */
  listActive(limit: number): Promise<readonly ActiveEvidenceRunRow[]>;
  /**
   * Settles runs nothing is working on any more as `failed` with the code
   * `abandoned`, clearing their credentials as `fail` would. Returns how many
   * rows it actually changed.
   *
   * Guarded on the active statuses, so a run that published or failed between
   * the sweep's read and this write keeps its outcome: recovery must never
   * overwrite a publication that landed while it was deciding.
   */
  releaseAbandoned(runIds: readonly string[]): Promise<number>;
  /**
   * Records what one attempt spent. Upserted on `(runId, attempt)`, so a
   * re-entered attempt refreshes its row rather than failing on the key.
   *
   * The caller is the evidence job, which writes this after its outcome is
   * settled and treats a failure here as a non-event: a lost measurement is
   * cheaper than a lost run.
   */
  recordRunCost(cost: EvidenceRunCost): Promise<void>;
  /**
   * Drops cost rows recorded before `cutoff`. Retention is deliberately weeks
   * rather than years: the question this table answers is always "what does a
   * run cost *now*", and an old row describes a configuration that no longer
   * runs -- which is the trap #342 was filed to close, not one to re-open with
   * a long tail of stale rows. Returns the number of rows removed.
   */
  clearExpiredRunCosts(cutoff: Date): Promise<number>;
}

/** One active evidence run, as recovery reads it. */
export type ActiveEvidenceRunRow = Readonly<{
  runId: string;
  /**
   * Whose run it is. Recovery needs it only to mark terminal tiers for a run
   * it republishes -- `markTerminalTiers` is keyed by character, not by run --
   * and it must not reach the sweep's log record, which carries counts alone.
   */
  key: CharacterKey;
  queueJobId: string | null;
  startedAt: Date | null;
  createdAt: Date;
}>;

export type FingerprintAdmission =
  | { kind: "not_due" }
  | { kind: "waiting"; retryAt: Date; blockedSince?: Date }
  | {
      kind: "admitted";
      reservationId: string;
      requestCap: number;
      committedRequests?: number;
      hourlyBudget?: number;
    };

export type FingerprintAdmissionDispatch =
  | { kind: "admitted" }
  | { kind: "waiting"; retryAt: Date; blockedSince?: Date }
  | { kind: "not_due" }
  | { kind: "settled" };

export interface FingerprintSweepRepository {
  /** True when a dossier visit may start a new cadence-gated sweep. */
  isDueForVisit?(key: CharacterKey, cadenceCutoff: Date): Promise<boolean>;
  requestAdmission(input: {
    runId: string;
    key: CharacterKey;
    requestCap: number;
    hourlyBudget: number;
    cadenceCutoff: Date;
    at: Date;
    /**
     * A continuation finishes the sweep already in progress rather than
     * starting a new one, so it is exempt from the cadence gate. Every other
     * gate still applies.
     */
    continuation?: true;
  }): Promise<FingerprintAdmission>;
  recordRequest(reservationId: string, count: number, at: Date): Promise<void>;
  finish(
    reservationId: string,
    input: { published: boolean; at: Date; limitationCode: string | null }
  ): Promise<void>;
  release(reservationId: string, at: Date): Promise<void>;
  getResumeState(key: CharacterKey): Promise<{
    resumeAfter: string;
    historicalGuilds: readonly CharacterGuild[];
    snapshotId: string;
    /**
     * The run that published `snapshotId`, and so the only run allowed to
     * continue this chain. A dispatch or amend for any other run is a no-op:
     * the cursor belongs to a sweep that run is not part of.
     */
    runId: string;
    limitationCode: string | null;
  } | null>;
  /**
   * Counts one continuation cycle that re-enqueued without advancing the
   * cursor and returns the new consecutive total. The count is reset to zero by
   * any cycle that does advance it.
   */
  recordContinuationFailure(key: CharacterKey): Promise<number>;
  listWaiting(limit: number, offset?: number): Promise<readonly string[]>;
  listAdmittedUndispatched(limit: number): Promise<readonly string[]>;
  markDispatched(runId: string, at: Date): Promise<void>;
  admitWaiting(runId: string, at: Date): Promise<FingerprintAdmissionDispatch>;
  cleanupExpired(at?: Date): Promise<number>;
}

export type SearchReservationResult =
  | { kind: "active"; run: DiscoveryRun }
  | { kind: "reserved"; run: DiscoveryRun }
  | { kind: "rate_limited"; retryAt: Date }
  | { kind: "fresh" }
  | { kind: "negative" }
  | { kind: "suppressed" };

export interface SearchReservationRepository {
  reserve(input: {
    key: CharacterKey;
    callerClass: CallerClass;
    callerBucketHash: string;
    limit: number;
    expiresAt: Date;
    at: Date;
    freshnessCutoff: Date;
  }): Promise<SearchReservationResult>;
  cancel(runId: string): Promise<void>;
  listPending(
    limit?: number
  ): Promise<Array<{ runId: string; key: CharacterKey }>>;
  markEnqueued(runId: string, queueJobId: string): Promise<void>;
}

/** An operator projection safe for application callers. */
export type Operator = Readonly<{
  id: string;
  canonicalLogin: string;
  displayLogin: string;
  active: boolean;
  credentialVersion: number;
  createdAt: Date;
  updatedAt: Date;
}>;

/** Safe account projection; credential material is confined to a separate type. */
export type Account = Readonly<{
  id: string;
  canonicalEmail: string;
  email: string;
  role: "user" | "admin";
  active: boolean;
  verifiedAt: Date | null;
  passwordChangeRequired: boolean;
  credentialVersion: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type AccountSummary = Pick<
  Account,
  "id" | "email" | "role" | "active" | "verifiedAt" | "createdAt"
>;

export type AccountCredential = Account &
  Readonly<{
    passwordHash: string;
    passwordSalt: string;
    scryptVersion: number;
    scryptCost: number;
  }>;

export type MailOutboxRow = Readonly<{
  id: string;
  encryptedMessage: string;
  idempotencyKey: string;
  expiresAt: Date;
  attempt: number;
}>;

export type Provider = "blizzard" | "raiderio" | "warcraftlogs";
export type ProviderPresence = Readonly<{
  provider: Provider;
  present: boolean;
  version: number;
  updatedAt: Date | null;
}>;
export type ProviderCredentials =
  | { provider: "blizzard"; clientId: string; clientSecret: string }
  | { provider: "raiderio"; accessKey: string }
  | { provider: "warcraftlogs"; clientId: string; clientSecret: string };

/** Concrete auth methods are supplied with the account repository implementation. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AccountAuthRepository {}
/** Concrete token and outbox methods are supplied with the mail implementation. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AccountMailRepository {}
/** Concrete key methods are supplied with the credential implementation. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AccountCredentialRepository {}

/**
 * The derived material needed only to verify an operator credential. This is
 * intentionally distinct from `Operator`, so ordinary callers never receive
 * a hash or salt; neither type can expose a raw password.
 */
export type OperatorCredential = Operator &
  Readonly<{
    passwordHash: string;
    passwordSalt: string;
    scryptVersion: number;
    scryptCost: number;
  }>;

/** A browser session projection that deliberately omits its secret digest. */
export type OperatorSession = Readonly<{
  id: string;
  operatorId: string;
  credentialVersion: number;
  issuedAt: Date;
  lastUsedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}>;

export type OperatorLoginAdmission =
  { kind: "admitted" } | { kind: "throttled"; retryAt: Date };

/** The only lifecycle actions an operator-auth audit record may name. */
export type OperatorAuthEventAction =
  | "provision"
  | "rotate"
  | "disable"
  | "sign_in"
  | "sign_out"
  | "session_revoke";

/** Safe, bounded outcomes for an operator-auth audit record. */
export type OperatorAuthEventOutcome = "success" | "failure";

/**
 * Persistence boundary for operator credentials and revocable browser
 * sessions. Inputs accept derived digests only; outputs never expose raw
 * passwords or browser-session secrets.
 */
export interface OperatorAuthRepository {
  findCredential(canonicalLogin: string): Promise<OperatorCredential | null>;
  provision(input: {
    canonicalLogin: string;
    displayLogin: string;
    passwordHash: string;
    passwordSalt: string;
    scryptVersion: number;
    scryptCost: number;
    at: Date;
  }): Promise<Operator>;
  rotateCredential(input: {
    operatorId: string;
    passwordHash: string;
    passwordSalt: string;
    scryptVersion: number;
    scryptCost: number;
    at: Date;
  }): Promise<Operator | null>;
  disable(operatorId: string, at: Date): Promise<Operator | null>;
  list(): Promise<readonly Operator[]>;
  admitLoginAttempt(input: {
    subjectHash: string;
    limit: number;
    expiresAt: Date;
    at: Date;
  }): Promise<OperatorLoginAdmission>;
  appendEvent(input: {
    operatorId: string | null;
    action: OperatorAuthEventAction;
    outcome: OperatorAuthEventOutcome;
    at: Date;
  }): Promise<void>;
  issueSession(input: {
    sessionId: string;
    secretDigest: string;
    operatorId: string;
    credentialVersion: number;
    issuedAt: Date;
    lastUsedAt: Date;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<OperatorSession>;
  useSession(input: {
    sessionId: string;
    secretDigest: string;
    at: Date;
    idleExpiresAt: Date;
  }): Promise<{ operator: Operator; session: OperatorSession } | null>;
  revokeSession(sessionId: string, at: Date): Promise<void>;
  cleanupExpired(at: Date): Promise<{
    sessions: number;
    loginAttempts: number;
  }>;
}

export interface Repositories {
  /** Transitional until the corresponding repository implementations land. */
  accountAuth?: AccountAuthRepository;
  accountMail?: AccountMailRepository;
  accountCredentials?: AccountCredentialRepository;
  operatorAuth: OperatorAuthRepository;
  searchReservations: SearchReservationRepository;
  runs: {
    createOrReuse(
      key: CharacterKey,
      caller: CallerClass
    ): Promise<DiscoveryRun>;
    claim(id: string, attempt: number): Promise<DiscoveryRun | null>;
    markRunning(id: string): Promise<void>;
    markRetrying(id: string, attempt: number, nextRetryAt: Date): Promise<void>;
    complete(id: string, snapshotId: string): Promise<void>;
    fail(id: string, code: PublicErrorCode): Promise<void>;
    find(id: string): Promise<DiscoveryRun | null>;
    findActive(key: CharacterKey): Promise<DiscoveryRun | null>;
  };
  snapshots: SnapshotRepository;
  manualConnections: ManualConnectionRepository;
  suppressions: SuppressionRepository;
  rateLimits: RateLimitRepository;
  negativeCache: NegativeCacheRepository;
  evidence: EvidenceRepository;
  fingerprintSweeps: FingerprintSweepRepository;
}
