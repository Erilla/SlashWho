import type { DossierCharacter } from "@slashwho/contracts";

type DossierCharacterListProps = Readonly<{
  characters: readonly DossierCharacter[];
}>;

const sourceLabel: Record<DossierCharacter["source"], string> = {
  submitted: "Submitted character",
  raiderio_declared: "Raider.IO declared",
  fingerprint_derived: "Fingerprint-derived"
};

const classColourClass: Record<string, string> = {
  "death knight": "death-knight",
  demonhunter: "demon-hunter",
  "demon hunter": "demon-hunter",
  druid: "druid",
  evoker: "evoker",
  hunter: "hunter",
  mage: "mage",
  monk: "monk",
  paladin: "paladin",
  priest: "priest",
  rogue: "rogue",
  shaman: "shaman",
  warlock: "warlock",
  warrior: "warrior"
};

function characterLinkClass(className: string | null): string {
  const classKey = className?.trim().toLowerCase();
  const colourClass = classKey ? classColourClass[classKey] : undefined;
  return colourClass
    ? `dossier-character-link dossier-character-link--${colourClass}`
    : "dossier-character-link";
}

export function DossierCharacterList({
  characters
}: DossierCharacterListProps) {
  return (
    <section
      aria-labelledby="dossier-characters-heading"
      className="dossier-panel"
    >
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
              <a
                className={characterLinkClass(character.className)}
                href={character.raiderIoUrl}
              >
                {character.displayName}
              </a>
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
