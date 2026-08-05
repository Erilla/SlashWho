import type { CharacterKey } from "./character-key";

export type DiscoverySource =
  "input" | "claimed" | "declared_main" | "profile_guess";

export interface DiscoveredCharacter {
  readonly key: CharacterKey;
  readonly displayName: string;
  readonly className: string;
  readonly level: number;
  readonly raiderIoUrl: string;
  readonly source: DiscoverySource;
}

function characterId(key: CharacterKey): string {
  return `${key.region}/${key.realm}/${key.name}`;
}

export function deduplicateCharacters(
  characters: readonly DiscoveredCharacter[]
): DiscoveredCharacter[] {
  const unique = new Set<string>();

  return characters.filter((character) => {
    const id = characterId(character.key);
    if (unique.has(id)) return false;
    unique.add(id);
    return true;
  });
}
