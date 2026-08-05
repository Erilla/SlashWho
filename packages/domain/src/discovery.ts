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
}

export interface RaiderIoProfile {
  readonly characters: readonly RaiderIoCharacter[];
}

export interface RaiderIoGateway {
  getCharacter(key: CharacterKey): Promise<RaiderIoCharacter>;
  getClaimedCharacters(ownerId: string): Promise<readonly RaiderIoCharacter[]>;
  resolveProfileGuess(value: string): Promise<RaiderIoProfile | null>;
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
      limitationCode: "privacy_hidden" | "request_cap";
      characters: readonly DiscoveredCharacter[];
    }
  | {
      kind: "failure";
      code:
        | "character_not_found"
        | "upstream_unavailable"
        | "upstream_schema_changed";
      retryable: boolean;
    };

export type DiscoverCharacterOptions = {
  requestCap: number;
  isSuppressed(key: CharacterKey): Promise<boolean>;
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
  return { kind: "failure", code: "upstream_unavailable", retryable: true };
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
  const visitedCharacters = new Set<string>();
  const visitedOwners = new Set<string>();
  const pendingCharacters: PendingCharacter[] = [
    { key: root, source: "input" }
  ];
  const inspectedCharacters: RaiderIoCharacter[] = [];
  const observations: DiscoveredCharacter[] = [];

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
    characters: readonly RaiderIoCharacter[],
    source: "claimed" | "profile_guess"
  ): Promise<void> {
    for (const character of characters) {
      if (!(await options.isSuppressed(character.key))) {
        observations.push(discoveredCharacter(character, source));
      }
    }
  }

  try {
    while (pendingCharacters.length > 0) {
      const pending = pendingCharacters.shift()!;
      const id = canonicalCharacterId(pending.key);
      if (
        visitedCharacters.has(id) ||
        (await options.isSuppressed(pending.key))
      ) {
        continue;
      }
      visitedCharacters.add(id);

      const character = await request(() => gateway.getCharacter(pending.key));
      if (character === budgetExhausted) break;
      if (!isRaiderIoCharacter(character)) throw schemaChanged();

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
          gateway.getClaimedCharacters(character.ownerId!)
        );
        if (claimed === budgetExhausted) break;
        if (!isCharacterList(claimed)) throw schemaChanged();
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
        const profile = await request(() => gateway.resolveProfileGuess(guess));
        if (profile === budgetExhausted) break;
        if (profile === null) continue;
        if (!isRaiderIoProfile(profile)) throw schemaChanged();
        await recordRelated(profile.characters, "profile_guess");
      }
      if (capped) break;
    }
  } catch (error) {
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
  return { kind: "snapshot", state: "complete", characters };
}
