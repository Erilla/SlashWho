import type { Character } from "@slashwho/contracts";
import { toCharacterPath } from "@slashwho/domain";
import Link from "next/link";

type CharacterListProps = Readonly<{
  characters: readonly Character[];
}>;

export function CharacterList({ characters }: CharacterListProps) {
  if (characters.length === 0) {
    return (
      <p className="empty-state">No characters were found in this refresh.</p>
    );
  }

  return (
    <ul className="character-list">
      {characters.map((character) => (
        <li
          className="character-row"
          key={`${character.region}/${character.realm}/${character.name.toLocaleLowerCase("en-US")}`}
        >
          <div>
            <Link
              className="character-name"
              href={toCharacterPath({
                region: character.region,
                realm: character.realm,
                name: character.name.toLocaleLowerCase("en-US")
              })}
            >
              {character.name}
            </Link>
            <span className="character-location">
              {character.region.toUpperCase()} · {character.realm}
            </span>
          </div>
          <span className="character-details">
            {character.className} · Level {character.level}
          </span>
        </li>
      ))}
    </ul>
  );
}
