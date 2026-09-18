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
   * True when this cycle moved the sweep forward -- it swept at least one new
   * candidate, or it exhausted the roster. False only for a cycle that swept
   * nothing new (the budget ran out before the first candidate), which is what
   * distinguishes a stuck chain from a slow one: `continuation_failures` is
   * reset on progress and preserved otherwise.
   */
  advanced: boolean;
}

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
    },
    cursor: FingerprintSweepCursor,
    options?: { signal?: AbortSignal }
  ): Promise<StoredSnapshot | null>;
  getCurrent(key: CharacterKey): Promise<StoredSnapshot | null>;
  getCurrentContainingCharacter?(
    key: CharacterKey
  ): Promise<StoredSnapshot | null>;
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
}

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
  isFinalBoss: boolean;
  killedAt: string;
  reportUrl: string;
  fightUrl: string;
  guild: { name: string; realm: string } | null;
  historicWorldRank?: number | null;
  performance: CharacterMythicKillPerformance;
}

export interface StoredCharacterMythicKill extends CharacterMythicKillInput {
  id: string;
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
}

export interface StoredCharacterMythicWipe extends CharacterMythicWipeInput {
  id: string;
}

export interface CompletedCharacterEvidence {
  run: CharacterEvidenceRun;
  /** Internal cache generation used to invalidate evidence after a parser fix. */
  evidenceVersion?: number;
  kills: readonly StoredCharacterMythicKill[];
  wipes: readonly StoredCharacterMythicWipe[];
  tierBests: readonly StoredCharacterTierBestParse[];
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

/** Where and when one stored kill happened, without its evidence. */
export type StoredKillTier = Readonly<{
  raidId: string;
  raidName: string;
  killedAt: string;
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
  limitationCode: string | null;
  parseLimitationCode: string | null;
  /** ISO 8601, or null when the publication carries no retry hint. */
  retryAfterAt: string | null;
  kills: readonly CharacterMythicKillInput[];
  wipes: readonly CharacterMythicWipeInput[];
  tierBests: readonly CharacterTierBestParseInput[];
  /** ISO 8601. */
  completedAt: string;
}

export interface EvidenceRepository {
  reserve(input: {
    key: CharacterKey;
    freshnessCutoff: Date;
    at: Date;
    credentials?: {
      wclClientIdEncrypted: string;
      wclClientSecretEncrypted: string;
    } | null;
  }): Promise<EvidenceReservationResult>;
  find(id: string): Promise<CharacterEvidenceRun | null>;
  claim(id: string, attempt: number): Promise<CharacterEvidenceRun | null>;
  markEnqueued(id: string, queueJobId: string): Promise<void>;
  publish(
    runId: string,
    input: {
      state: "complete" | "partial";
      limitationCode: string | null;
      parseLimitationCode: string | null;
      retryAfterAt?: Date | null;
      kills: readonly CharacterMythicKillInput[];
      wipes: readonly CharacterMythicWipeInput[];
      /**
       * Zones this run actually read. The budget covers only a few tiers per
       * run, so the ones it did not reach are carried forward from the
       * character's previous evidence rather than written back blank.
       */
      tierBests: readonly CharacterTierBestParseInput[];
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
  /**
   * Fight URLs already carrying at least one available parse metric, so a
   * budget-limited collection run can spend its requests on what is missing
   * instead of redoing the same reports every time.
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
   * The raid, name and kill time of every stored kill. This is what turns a
   * terminal raid id into a date the report scan can stop at: the marks carry
   * Warcraft Logs zone ids, and only the kills say when that zone was raided.
   *
   * Scoped like `hydratedFightUrls`, to the evidence `getCompleted` returns.
   */
  storedKillTiers(key: CharacterKey): Promise<readonly StoredKillTier[]>;
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
}

/** One active evidence run, as recovery reads it. */
export type ActiveEvidenceRunRow = Readonly<{
  runId: string;
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

export interface Repositories {
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
