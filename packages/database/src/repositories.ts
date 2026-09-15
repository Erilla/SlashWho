import type {
  DiscoveryRunStatus,
  PublicErrorCode,
  SnapshotState
} from "@slashwho/contracts";
import type { CharacterKey } from "@slashwho/domain";

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
    options?: { signal?: AbortSignal }
  ): Promise<StoredSnapshot>;
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
}

export interface ManualConnectionRepository {
  list(root: CharacterKey): Promise<readonly ManualConnectionCharacter[]>;
  add(
    root: CharacterKey,
    character: CharacterKey
  ): Promise<"added" | "duplicate">;
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
  wipeCapable: boolean;
}

export type EvidenceReservationResult =
  | {
      kind: "fresh";
      run: CharacterEvidenceRun;
      completed: CompletedCharacterEvidence;
    }
  | {
      kind: "active";
      run: CharacterEvidenceRun;
      completed: CompletedCharacterEvidence | null;
    }
  | {
      kind: "reserved";
      run: CharacterEvidenceRun;
      completed: CompletedCharacterEvidence | null;
    };

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
      completedAt: Date;
    }
  ): Promise<void>;
  fail(id: string, code: string): Promise<void>;
  getCompleted(key: CharacterKey): Promise<CompletedCharacterEvidence | null>;
  listStatus(keys: readonly CharacterKey[]): Promise<CharacterEvidenceRun[]>;
  /**
   * Clears any lingering encrypted WCL credential columns from evidence runs
   * created before `cutoff`. `publish` and `fail` already clear these columns
   * on every normal completion path; this is the backstop for a run whose job
   * never reaches either (a crash, a timeout, a killed process between
   * `claim()` and `publish()`/`fail()`), so ciphertext never outlives the run
   * by more than the retention window. Returns the number of rows cleared.
   */
  clearStaleCredentials(cutoff: Date): Promise<number>;
}

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
  }): Promise<FingerprintAdmission>;
  recordRequest(reservationId: string, count: number, at: Date): Promise<void>;
  finish(
    reservationId: string,
    input: { published: boolean; at: Date; limitationCode: string | null }
  ): Promise<void>;
  release(reservationId: string, at: Date): Promise<void>;
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
