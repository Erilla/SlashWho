import type { DossierCharacter } from "@slashwho/contracts";

type DossierCharacterListProps = Readonly<{
  characters: readonly DossierCharacter[];
}>;

const sourceLabel: Record<DossierCharacter["source"], string> = {
  submitted: "Submitted character",
  raiderio_declared: "Raider.IO declared",
  fingerprint_derived: "Fingerprint-derived"
};

export function DossierCharacterList({
  characters
}: DossierCharacterListProps) {
  return (
    <section aria-labelledby="dossier-characters-heading">
      <h2 className="section-heading" id="dossier-characters-heading">
        Connected characters
      </h2>
      <ul className="dossier-character-list">
        {characters.map((character) => (
          <li
            className="dossier-character-row"
            key={`${character.key.region}/${character.key.realm}/${character.key.name}`}
          >
            <div>
              <strong>{character.displayName}</strong>
              <span className="dossier-location">
                {character.key.region.toUpperCase()} · {character.key.realm}
              </span>
            </div>
            <span className="source-badge">
              {sourceLabel[character.source]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
