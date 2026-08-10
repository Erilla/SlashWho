import { toRaiderIoUrl, type CharacterKey } from "./character-key";
import { canonicalCharacterId, type DiscoveredCharacter } from "./deduplicate";

const mandatoryMinimumCommon = 200;
const mandatoryMinimumIdenticalPercent = 20;
const budgetExhausted = Symbol("budget_exhausted");

export type FingerprintCandidate = Readonly<{
  key: CharacterKey;
  displayName: string;
  className: string;
  level: number;
}>;

export interface FingerprintGateway {
  getGuildRoster(
    root: CharacterKey,
    signal?: AbortSignal
  ): Promise<readonly FingerprintCandidate[]>;
  getAchievementFingerprint(
    key: CharacterKey,
    signal?: AbortSignal
  ): Promise<ReadonlyMap<number, number>>;
}

export type FingerprintSweepOutcome =
  | {
      kind: "matched";
      characters: readonly DiscoveredCharacter[];
      requestsUsed: number;
    }
  | {
      kind: "capped";
      characters: readonly DiscoveredCharacter[];
      requestsUsed: number;
    }
  | {
      kind: "failure";
      code: "upstream_unavailable" | "upstream_schema_changed";
      retryable: boolean;
      retryAfterMs?: number;
    };

export type DiscoverFingerprintMatchesOptions = {
  requestCap: number;
  minimumCommon: number;
  minimumIdenticalPercent: number;
  isSuppressed(key: CharacterKey): Promise<boolean>;
  isPrivacyHidden(key: CharacterKey): Promise<boolean>;
  signal?: AbortSignal;
};

function isCharacterKey(value: unknown): value is CharacterKey {
  if (typeof value !== "object" || value === null) return false;

  return (
    "region" in value &&
    typeof value.region === "string" &&
    "realm" in value &&
    typeof value.realm === "string" &&
    "name" in value &&
    typeof value.name === "string"
  );
}

function isCandidate(value: unknown): value is FingerprintCandidate {
  if (typeof value !== "object" || value === null) return false;

  return (
    "key" in value &&
    isCharacterKey(value.key) &&
    "displayName" in value &&
    typeof value.displayName === "string" &&
    "className" in value &&
    typeof value.className === "string" &&
    "level" in value &&
    typeof value.level === "number"
  );
}

function isCandidateList(
  value: unknown
): value is readonly FingerprintCandidate[] {
  return Array.isArray(value) && value.every(isCandidate);
}

function isFingerprint(value: unknown): value is ReadonlyMap<number, number> {
  return (
    value instanceof Map &&
    [...value].every(
      ([achievementId, timestamp]) =>
        typeof achievementId === "number" &&
        Number.isFinite(achievementId) &&
        typeof timestamp === "number" &&
        Number.isFinite(timestamp)
    )
  );
}

function compareCandidates(
  left: FingerprintCandidate,
  right: FingerprintCandidate
): number {
  return canonicalCharacterId(left.key).localeCompare(
    canonicalCharacterId(right.key)
  );
}

function fingerprintMatches(
  root: ReadonlyMap<number, number>,
  candidate: ReadonlyMap<number, number>,
  options: DiscoverFingerprintMatchesOptions
): boolean {
  let common = 0;
  let identical = 0;

  for (const [achievementId, timestamp] of root) {
    const candidateTimestamp = candidate.get(achievementId);
    if (candidateTimestamp === undefined) continue;

    common += 1;
    if (candidateTimestamp === timestamp) identical += 1;
  }

  const identicalPercent = common === 0 ? 0 : (identical / common) * 100;
  return (
    common >= Math.max(mandatoryMinimumCommon, options.minimumCommon) &&
    identicalPercent >=
      Math.max(
        mandatoryMinimumIdenticalPercent,
        options.minimumIdenticalPercent
      )
  );
}

function discoveredCharacter(
  candidate: FingerprintCandidate
): DiscoveredCharacter {
  return {
    key: candidate.key,
    displayName: candidate.displayName,
    className: candidate.className,
    level: candidate.level,
    raiderIoUrl: toRaiderIoUrl(candidate.key),
    source: "fingerprint"
  };
}

function failureOutcome(error: unknown): FingerprintSweepOutcome {
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? error.kind
      : undefined;

  if (kind === "schema_drift") {
    return {
      kind: "failure",
      code: "upstream_schema_changed",
      retryable: false
    };
  }

  const retryAfterMs =
    typeof error === "object" &&
    error !== null &&
    "retryAfterMs" in error &&
    typeof error.retryAfterMs === "number" &&
    Number.isFinite(error.retryAfterMs) &&
    error.retryAfterMs >= 0
      ? error.retryAfterMs
      : undefined;

  return {
    kind: "failure",
    code: "upstream_unavailable",
    retryable: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs })
  };
}

export async function discoverFingerprintMatches(
  root: CharacterKey,
  gateway: FingerprintGateway,
  options: DiscoverFingerprintMatchesOptions
): Promise<FingerprintSweepOutcome> {
  let remainingRequests = Number.isFinite(options.requestCap)
    ? Math.max(0, Math.floor(options.requestCap))
    : 0;
  let requestsUsed = 0;
  let capped = false;
  const matches: DiscoveredCharacter[] = [];

  function throwIfAborted(): void {
    options.signal?.throwIfAborted();
  }

  async function request<T>(
    operation: () => Promise<T>
  ): Promise<T | typeof budgetExhausted> {
    throwIfAborted();
    if (remainingRequests === 0) {
      capped = true;
      return budgetExhausted;
    }

    remainingRequests -= 1;
    requestsUsed += 1;
    const result = await operation();
    throwIfAborted();
    return result;
  }

  try {
    const roster = await request(() =>
      gateway.getGuildRoster(root, options.signal)
    );
    if (roster === budgetExhausted) {
      return { kind: "capped", characters: [], requestsUsed };
    }
    if (!isCandidateList(roster)) throw { kind: "schema_drift" };

    const rootFingerprint = await request(() =>
      gateway.getAchievementFingerprint(root, options.signal)
    );
    if (rootFingerprint === budgetExhausted) {
      return { kind: "capped", characters: [], requestsUsed };
    }
    if (!isFingerprint(rootFingerprint)) throw { kind: "schema_drift" };

    const rootId = canonicalCharacterId(root);
    const candidates = [...roster].sort(compareCandidates);
    const seen = new Set<string>();
    for (const candidate of candidates) {
      throwIfAborted();
      const candidateId = canonicalCharacterId(candidate.key);
      if (
        candidateId === rootId ||
        seen.has(candidateId) ||
        candidate.key.region !== root.region
      ) {
        continue;
      }
      seen.add(candidateId);

      const isSuppressed = await options.isSuppressed(candidate.key);
      throwIfAborted();
      if (isSuppressed) continue;
      const isPrivacyHidden = await options.isPrivacyHidden(candidate.key);
      throwIfAborted();
      if (isPrivacyHidden) continue;

      const candidateFingerprint = await request(() =>
        gateway.getAchievementFingerprint(candidate.key, options.signal)
      );
      if (candidateFingerprint === budgetExhausted) break;
      if (!isFingerprint(candidateFingerprint)) throw { kind: "schema_drift" };

      if (!fingerprintMatches(rootFingerprint, candidateFingerprint, options)) {
        continue;
      }
      const isSuppressedBeforeAdmission = await options.isSuppressed(
        candidate.key
      );
      throwIfAborted();
      if (isSuppressedBeforeAdmission) continue;
      const isPrivacyHiddenBeforeAdmission = await options.isPrivacyHidden(
        candidate.key
      );
      throwIfAborted();
      if (isPrivacyHiddenBeforeAdmission) continue;

      matches.push(discoveredCharacter(candidate));
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (
      typeof error === "object" &&
      error !== null &&
      "kind" in error &&
      error.kind === "fingerprint_cap_reached"
    ) {
      return { kind: "capped", characters: matches, requestsUsed };
    }
    return failureOutcome(error);
  }

  return capped
    ? { kind: "capped", characters: matches, requestsUsed }
    : { kind: "matched", characters: matches, requestsUsed };
}
