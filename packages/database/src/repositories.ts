import type {
  DiscoveryRunStatus,
  PublicErrorCode,
  SnapshotState
} from "@slashwho/contracts";
import type { CharacterKey } from "@slashwho/domain";

export type CallerClass = "anonymous" | "bot";
export type DiscoverySource =
  "input" | "claimed" | "declared_main" | "profile_guess";

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
  getCurrent(key: CharacterKey): Promise<StoredSnapshot | null>;
  find(id: string): Promise<StoredSnapshot | null>;
  listHistory(
    key: CharacterKey,
    page: { cursor: string | null; limit: number }
  ): Promise<SnapshotHistoryPage>;
}

export interface SuppressionRepository {
  suppress(
    key: CharacterKey,
    reason: string,
    expiresAt: Date | null
  ): Promise<void>;
  isActive(key: CharacterKey, at?: Date): Promise<boolean>;
}

export interface RateLimitRepository {
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
}

export interface Repositories {
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
  suppressions: SuppressionRepository;
  rateLimits: RateLimitRepository;
  negativeCache: NegativeCacheRepository;
}
