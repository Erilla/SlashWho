import {
  toRaiderIoUrl,
  type CharacterGuild,
  type CharacterKey
} from "./character-key";
import { canonicalCharacterId, type DiscoveredCharacter } from "./deduplicate";

const mandatoryMinimumCommon = 200;
const mandatoryMinimumIdenticalPercent = 20;
const budgetExhausted = Symbol("budget_exhausted");

export type FingerprintCandidate = Readonly<{
  key: CharacterKey;
  displayName: string;
  className: string;
  level: number;
  /**
   * The guild whose roster named this candidate. Optional because isCandidate
   * does not require it: a gateway that names no guild costs one guild, not the
   * sweep.
   */
  guild?: CharacterGuild | null;
}>;

export interface FingerprintGateway {
  getGuildRoster(
    root: CharacterKey,
    signal?: AbortSignal
  ): Promise<readonly FingerprintCandidate[]>;
  /**
   * Reads a guild selected by public historical raid evidence. It is separate
   * from `getGuildRoster` because no character-profile lookup should be needed
   * to rediscover a historical guild's current roster.
   */
  getGuildRosterByIdentity(
    guild: CharacterGuild,
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
      /**
       * Absent when the budget ended before any candidate was swept: the
       * roster and root-fingerprint fetches both cap out ahead of the loop.
       * A capped outcome with no cursor must leave a stored cursor unchanged.
       */
      resumeAfter?: string;
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
  signal?: AbortSignal;
  /**
   * Canonical id of the last candidate a previous cycle swept. Resumption is
   * strictly greater than this, so a candidate is never swept twice.
   */
  resumeAfter?: string;
  /**
   * Region-qualified public report guilds from the snapshot that began this
   * sweep. The caller freezes this list before a continuation can amend the
   * snapshot, which keeps this a one-hop traversal.
   */
  historicalGuilds?: readonly CharacterGuild[];
  /**
   * How many candidate reads the sweep keeps outstanding at once. Defaults to
   * one, a serial sweep. This only lets the sweep offer reads concurrently: the
   * process-wide concurrency and rate limits belong on the gateway's client,
   * which every caller of the same credentials shares.
   */
  readConcurrency?: number;
};

type CandidateResult =
  | { kind: "skipped" }
  | { kind: "swept"; id: string; match?: DiscoveredCharacter }
  | { kind: "unread"; id: string };

function readConcurrency(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value >= 1
    ? value
    : 1;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    error.kind === "not_found"
  );
}

function isCapReached(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    error.kind === "fingerprint_cap_reached"
  );
}

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

function canonicalGuildId(guild: CharacterGuild): string {
  return `${guild.region}/${guild.realm}/${guild.name}`;
}

function compareGuilds(left: CharacterGuild, right: CharacterGuild): number {
  return canonicalGuildId(left).localeCompare(canonicalGuildId(right));
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
    // The sweep reads exactly one roster, the root's own, so every candidate is
    // in that guild by construction. The guild is already read to build the
    // roster URL, so carrying it costs no request. It is coalesced rather than
    // required by isCandidate: a gateway that names no guild should cost this
    // one guild, not abandon the sweep as structural change.
    guild: candidate.guild ?? null,
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
  let lastSweptId: string | undefined;

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
    // Blizzard holds no current profile for plenty of characters Raider.IO
    // knows, and answers 404. That makes this root unsweepable rather than the
    // upstream broken, so report an empty sweep and let its Raider.IO snapshot
    // publish instead of stranding the run on a retry that cannot succeed.
    let roster: readonly FingerprintCandidate[] | typeof budgetExhausted;
    try {
      roster = await request(() =>
        gateway.getGuildRoster(root, options.signal)
      );
    } catch (error) {
      if (isNotFound(error)) {
        return { kind: "matched", characters: [], requestsUsed };
      }
      throw error;
    }
    if (roster === budgetExhausted) {
      return { kind: "capped", characters: [], requestsUsed };
    }
    if (!isCandidateList(roster)) throw { kind: "schema_drift" };

    let rootFingerprint: ReadonlyMap<number, number> | typeof budgetExhausted;
    try {
      rootFingerprint = await request(() =>
        gateway.getAchievementFingerprint(root, options.signal)
      );
    } catch (error) {
      if (isNotFound(error)) {
        return { kind: "matched", characters: [], requestsUsed };
      }
      throw error;
    }
    if (rootFingerprint === budgetExhausted) {
      return { kind: "capped", characters: [], requestsUsed };
    }
    if (!isFingerprint(rootFingerprint)) throw { kind: "schema_drift" };

    const historicalRosters: FingerprintCandidate[] = [];
    const seenGuilds = new Set<string>();
    for (const guild of [...(options.historicalGuilds ?? [])].sort(
      compareGuilds
    )) {
      throwIfAborted();
      const guildId = canonicalGuildId(guild);
      if (seenGuilds.has(guildId)) continue;
      seenGuilds.add(guildId);

      try {
        const historicalRoster = await request(() =>
          gateway.getGuildRosterByIdentity(guild, options.signal)
        );
        if (historicalRoster === budgetExhausted) break;
        if (!isCandidateList(historicalRoster)) throw { kind: "schema_drift" };
        historicalRosters.push(
          ...historicalRoster.map((candidate) => ({
            ...candidate,
            guild: candidate.guild ?? guild
          }))
        );
      } catch (error) {
        // A guild can be renamed or disbanded after its public report. It is an
        // exhausted source, not a fault that invalidates every other guild.
        if (isNotFound(error)) continue;
        throw error;
      }
    }

    const rootId = canonicalCharacterId(root);
    const candidatesById = new Map<string, FingerprintCandidate>();
    for (const candidate of [...roster, ...historicalRosters]) {
      const candidateId = canonicalCharacterId(candidate.key);
      if (!candidatesById.has(candidateId)) {
        candidatesById.set(candidateId, candidate);
      }
    }
    const sorted = [...candidatesById.values()].sort(compareCandidates);
    const candidates = options.resumeAfter
      ? sorted.filter(
          (item) =>
            canonicalCharacterId(item.key).localeCompare(options.resumeAfter!) >
            0
        )
      : sorted;
    const seen = new Set<string>();
    const eligible: { candidate: FingerprintCandidate; id: string }[] = [];
    for (const candidate of candidates) {
      const candidateId = canonicalCharacterId(candidate.key);
      if (
        candidateId === rootId ||
        seen.has(candidateId) ||
        candidate.key.region !== root.region
      ) {
        continue;
      }
      seen.add(candidateId);
      eligible.push({ candidate, id: candidateId });
    }

    const verifiedRootFingerprint = rootFingerprint;
    const concurrency = readConcurrency(options.readConcurrency);
    // One entry per eligible candidate, filled as each settles. Reads complete
    // out of order, so results are only folded into the outcome afterwards, in
    // candidate order, which keeps admission order and the cursor identical to
    // a serial sweep.
    const settled: (CandidateResult | undefined)[] = [];
    const inFlight = new Set<Promise<void>>();
    const suppressionChecks = new Map<number, Promise<boolean>>();
    const outstanding: Promise<unknown>[] = [];
    let stopped = false;
    let failure: { index: number; error: unknown } | undefined;

    // The first suppression check is looked ahead across the next window of
    // candidates, so the dispatcher rarely waits on it. It stays a separate
    // check from the one immediately before admission.
    function suppressedAt(index: number): Promise<boolean> {
      const end = Math.min(eligible.length, index + concurrency);
      for (let ahead = index; ahead < end; ahead += 1) {
        if (suppressionChecks.has(ahead)) continue;
        const check = options.isSuppressed(eligible[ahead]!.candidate.key);
        // Handled here so a look-ahead the sweep never reaches cannot surface
        // as an unhandled rejection; the awaited copy still rejects.
        outstanding.push(check.catch(() => undefined));
        suppressionChecks.set(ahead, check);
      }
      const check = suppressionChecks.get(index)!;
      suppressionChecks.delete(index);
      return check;
    }

    function readCandidate(index: number): Promise<void> {
      const { candidate, id } = eligible[index]!;
      // `request` runs synchronously up to the gateway call, so reads reach
      // the gateway, and so reserve budget, strictly in candidate order. A
      // budget that ends mid-window therefore ends at one candidate: every
      // earlier read has its request and every later one is refused.
      return request(() =>
        gateway.getAchievementFingerprint(candidate.key, options.signal)
      ).then(
        async (candidateFingerprint) => {
          if (candidateFingerprint === budgetExhausted) {
            settled[index] = { kind: "unread", id };
            stopped = true;
            return;
          }
          if (!isFingerprint(candidateFingerprint)) {
            throw { kind: "schema_drift" };
          }
          if (
            !fingerprintMatches(
              verifiedRootFingerprint,
              candidateFingerprint,
              options
            )
          ) {
            settled[index] = { kind: "swept", id };
            return;
          }
          const isSuppressedBeforeAdmission = await options.isSuppressed(
            candidate.key
          );
          throwIfAborted();
          settled[index] = isSuppressedBeforeAdmission
            ? { kind: "swept", id }
            : { kind: "swept", id, match: discoveredCharacter(candidate) };
        },
        (error: unknown) => {
          // A roster member with no readable achievement profile is ordinary,
          // not an upstream fault: the measured live sweep saw 23 of 393
          // candidates return one. Skip the candidate and keep the request it
          // already consumed.
          if (isNotFound(error)) {
            settled[index] = { kind: "swept", id };
            return;
          }
          if (isCapReached(error)) {
            // The gateway refused the read before spending anything, and with
            // several reads outstanding more than one can be refused.
            requestsUsed -= 1;
            settled[index] = { kind: "unread", id };
            capped = true;
            stopped = true;
            return;
          }
          throw error;
        }
      );
    }

    try {
      for (let index = 0; index < eligible.length; index += 1) {
        while (inFlight.size >= concurrency && !stopped) {
          await Promise.race(inFlight);
        }
        if (stopped) break;
        throwIfAborted();

        const isSuppressed = await suppressedAt(index);
        throwIfAborted();
        if (stopped) break;
        if (isSuppressed) {
          settled[index] = { kind: "skipped" };
          continue;
        }

        const read = readCandidate(index)
          .catch((error: unknown) => {
            stopped = true;
            // The earliest candidate's failure wins, so the outcome does not
            // depend on which of several failing reads answered first.
            if (failure === undefined || index < failure.index) {
              failure = { index, error };
            }
          })
          .finally(() => {
            inFlight.delete(read);
          });
        inFlight.add(read);
      }
    } finally {
      // Nothing returns while a read is still in flight: its budget write
      // would otherwise race the caller releasing the reservation.
      await Promise.allSettled([...inFlight, ...outstanding]);
    }
    if (failure !== undefined) throw failure.error;

    // The cursor stops at the first candidate whose read never completed, so
    // the next sweep resumes there rather than skipping it.
    for (const result of settled) {
      if (result === undefined || result.kind === "unread") break;
      if (result.kind === "skipped") continue;
      lastSweptId = result.id;
      if (result.match) matches.push(result.match);
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (isCapReached(error)) {
      return {
        kind: "capped",
        characters: matches,
        requestsUsed,
        ...(lastSweptId === undefined ? {} : { resumeAfter: lastSweptId })
      };
    }
    return failureOutcome(error);
  }

  return capped
    ? {
        kind: "capped",
        characters: matches,
        requestsUsed,
        ...(lastSweptId === undefined ? {} : { resumeAfter: lastSweptId })
      }
    : { kind: "matched", characters: matches, requestsUsed };
}
