import { toRaiderIoUrl, type CharacterKey } from "./character-key";
import {
  canonicalCharacterId,
  deduplicateCharacters,
  type DiscoveredCharacter,
  type DiscoverySource
} from "./deduplicate";

export interface RaiderIoCharacter {
  readonly key: CharacterKey;
  readonly displayName: string;
  readonly className: string;
  readonly level: number;
  readonly ownerId: string | null;
  readonly profileGuess: string | null;
  readonly declaredMain: CharacterKey | null;
  /**
   * True when the upstream payload named at least one related character this
   * system cannot represent (for example a character in an unsupported region),
   * so anything derived from it is knowingly incomplete.
   */
  readonly omittedMembers?: boolean;
}

export interface RaiderIoProfile {
  readonly characters: readonly RaiderIoCharacter[];
  /** See {@link RaiderIoCharacter.omittedMembers}. */
  readonly omittedMembers?: boolean;
}

export interface RaiderIoGateway {
  getCharacter(
    key: CharacterKey,
    signal?: AbortSignal
  ): Promise<RaiderIoCharacter>;
  getClaimedCharacters(
    ownerId: string,
    signal?: AbortSignal
  ): Promise<RaiderIoProfile>;
  resolveProfileGuess(
    value: string,
    signal?: AbortSignal
  ): Promise<RaiderIoProfile | null>;
}

export type DiscoveryOutcome =
  | {
      kind: "snapshot";
      state: "complete";
      characters: readonly DiscoveredCharacter[];
    }
  | {
      kind: "snapshot";
      state: "partial";
      limitationCode: "privacy_hidden" | "request_cap" | "unsupported_member";
      characters: readonly DiscoveredCharacter[];
    }
  | {
      kind: "failure";
      code:
        | "character_not_found"
        | "upstream_unavailable"
        | "upstream_schema_changed";
      retryable: boolean;
      retryAfterMs?: number;
    };

export type DiscoverCharacterOptions = {
  requestCap: number;
  isSuppressed(key: CharacterKey): Promise<boolean>;
  signal?: AbortSignal;
};

type PendingCharacter = {
  key: CharacterKey;
  source: "input" | "declared_main";
};

const budgetExhausted = Symbol("budget_exhausted");

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

function isRaiderIoCharacter(value: unknown): value is RaiderIoCharacter {
  if (typeof value !== "object" || value === null) return false;

  return (
    "key" in value &&
    isCharacterKey(value.key) &&
    "displayName" in value &&
    typeof value.displayName === "string" &&
    "className" in value &&
    typeof value.className === "string" &&
    "level" in value &&
    typeof value.level === "number" &&
    "ownerId" in value &&
    (typeof value.ownerId === "string" || value.ownerId === null) &&
    "profileGuess" in value &&
    (typeof value.profileGuess === "string" || value.profileGuess === null) &&
    "declaredMain" in value &&
    (isCharacterKey(value.declaredMain) || value.declaredMain === null)
  );
}

function isCharacterList(
  value: unknown
): value is readonly RaiderIoCharacter[] {
  return Array.isArray(value) && value.every(isRaiderIoCharacter);
}

function isRaiderIoProfile(value: unknown): value is RaiderIoProfile {
  return (
    typeof value === "object" &&
    value !== null &&
    "characters" in value &&
    isCharacterList(value.characters)
  );
}

function schemaChanged(): { kind: "schema_drift" } {
  return { kind: "schema_drift" };
}

function compareCharacterKeys(
  left: DiscoveredCharacter,
  right: DiscoveredCharacter
): number {
  return (
    left.key.region.localeCompare(right.key.region) ||
    left.key.realm.localeCompare(right.key.realm) ||
    left.key.name.localeCompare(right.key.name)
  );
}

function discoveredCharacter(
  character: RaiderIoCharacter,
  source: DiscoverySource
): DiscoveredCharacter {
  return {
    key: character.key,
    displayName: character.displayName,
    className: character.className,
    level: character.level,
    raiderIoUrl: toRaiderIoUrl(character.key),
    source
  };
}

function failureOutcome(error: unknown): DiscoveryOutcome {
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? error.kind
      : undefined;

  if (kind === "not_found") {
    return { kind: "failure", code: "character_not_found", retryable: false };
  }
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

export async function discoverCharacter(
  root: CharacterKey,
  gateway: RaiderIoGateway,
  options: DiscoverCharacterOptions
): Promise<DiscoveryOutcome> {
  let budget = Number.isFinite(options.requestCap)
    ? Math.max(0, Math.floor(options.requestCap))
    : 0;
  let capped = false;
  let privacyHidden = false;
  let omittedMembers = false;
  const visitedCharacters = new Set<string>();
  const visitedOwners = new Set<string>();
  const pendingCharacters: PendingCharacter[] = [
    { key: root, source: "input" }
  ];
  const inspectedCharacters: RaiderIoCharacter[] = [];
  const observations: DiscoveredCharacter[] = [];

  function throwIfAborted(): void {
    options.signal?.throwIfAborted();
  }

  async function request<T>(
    operation: () => Promise<T>
  ): Promise<T | typeof budgetExhausted> {
    if (budget === 0) {
      capped = true;
      return budgetExhausted;
    }
    budget -= 1;
    return operation();
  }

  async function recordRelated(
    profile: RaiderIoProfile,
    source: "claimed" | "profile_guess"
  ): Promise<void> {
    if (profile.omittedMembers) omittedMembers = true;
    for (const character of profile.characters) {
      throwIfAborted();
      if (character.omittedMembers) omittedMembers = true;
      if (!(await options.isSuppressed(character.key))) {
        throwIfAborted();
        observations.push(discoveredCharacter(character, source));
      }
    }
  }

  try {
    // Suppression can land between reservation and execution. Discovering a
    // suppressed root would otherwise publish a snapshot with no root row, which
    // no read can ever anchor and no retry can ever repair.
    if (await options.isSuppressed(root)) {
      return { kind: "failure", code: "character_not_found", retryable: false };
    }

    while (pendingCharacters.length > 0) {
      throwIfAborted();
      const pending = pendingCharacters.shift()!;
      const id = canonicalCharacterId(pending.key);
      if (
        visitedCharacters.has(id) ||
        (await options.isSuppressed(pending.key))
      ) {
        continue;
      }
      visitedCharacters.add(id);

      const character = await request(() =>
        gateway.getCharacter(pending.key, options.signal)
      );
      throwIfAborted();
      if (character === budgetExhausted) break;
      if (!isRaiderIoCharacter(character)) throw schemaChanged();
      if (character.omittedMembers) omittedMembers = true;

      observations.push(discoveredCharacter(character, pending.source));
      inspectedCharacters.push(character);
      if (character.declaredMain) {
        pendingCharacters.push({
          key: character.declaredMain,
          source: "declared_main"
        });
      }
    }

    for (const character of inspectedCharacters) {
      if (character.ownerId) {
        if (visitedOwners.has(character.ownerId)) continue;
        visitedOwners.add(character.ownerId);
        const claimed = await request(() =>
          gateway.getClaimedCharacters(character.ownerId!, options.signal)
        );
        throwIfAborted();
        if (claimed === budgetExhausted) break;
        if (!isRaiderIoProfile(claimed)) throw schemaChanged();
        await recordRelated(claimed, "claimed");
        continue;
      }

      privacyHidden = true;
      const guesses = new Set(
        [character.profileGuess, character.key.name].filter(
          (guess): guess is string => guess !== null
        )
      );
      for (const guess of guesses) {
        const profile = await request(() =>
          gateway.resolveProfileGuess(guess, options.signal)
        );
        throwIfAborted();
        if (profile === budgetExhausted) break;
        if (profile === null) continue;
        if (!isRaiderIoProfile(profile)) throw schemaChanged();
        await recordRelated(profile, "profile_guess");
      }
      if (capped) break;
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    return failureOutcome(error);
  }

  const primary = observations.filter(
    (character) =>
      character.source === "input" || character.source === "declared_main"
  );
  const related = observations
    .filter(
      (character) =>
        character.source === "claimed" || character.source === "profile_guess"
    )
    .sort(compareCharacterKeys);
  const characters = deduplicateCharacters([...primary, ...related]);

  // A snapshot is anchored to its root character. Without a root observation the
  // repository write cannot complete, so refuse rather than publishing a snapshot
  // that is guaranteed to roll back and burn every retry.
  const rootId = canonicalCharacterId(root);
  if (!characters.some((item) => canonicalCharacterId(item.key) === rootId)) {
    return capped
      ? { kind: "failure", code: "upstream_unavailable", retryable: true }
      : { kind: "failure", code: "character_not_found", retryable: false };
  }

  if (capped) {
    return {
      kind: "snapshot",
      state: "partial",
      limitationCode: "request_cap",
      characters
    };
  }
  if (privacyHidden) {
    return {
      kind: "snapshot",
      state: "partial",
      limitationCode: "privacy_hidden",
      characters
    };
  }
  if (omittedMembers) {
    return {
      kind: "snapshot",
      state: "partial",
      limitationCode: "unsupported_member",
      characters
    };
  }
  return { kind: "snapshot", state: "complete", characters };
}
