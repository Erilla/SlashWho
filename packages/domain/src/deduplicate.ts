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

export function canonicalCharacterId(key: CharacterKey): string {
  return JSON.stringify([
    key.region.toLocaleLowerCase("en-US"),
    key.realm.toLocaleLowerCase("en-US"),
    key.name.toLocaleLowerCase("en-US")
  ]);
}

export function deduplicateCharacters(
  characters: readonly DiscoveredCharacter[]
): DiscoveredCharacter[] {
  const unique = new Set<string>();

  return characters.filter((character) => {
    const id = canonicalCharacterId(character.key);
    if (unique.has(id)) return false;
    unique.add(id);
    return true;
  });
}
