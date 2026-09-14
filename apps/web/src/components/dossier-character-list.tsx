import type { DossierCharacter } from "@slashwho/contracts";
import { useEffect, useRef, useState } from "react";

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
  const listRef = useRef<HTMLUListElement>(null);
  const [isScrollable, setIsScrollable] = useState(false);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof window.matchMedia !== "function") return;

    const desktop = window.matchMedia("(width > 48rem)");
    const updateScrollable = () => {
      setIsScrollable(desktop.matches && list.scrollHeight > list.clientHeight);
    };
    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(updateScrollable)
        : null;

    updateScrollable();
    resizeObserver?.observe(list);
    desktop.addEventListener("change", updateScrollable);

    return () => {
      resizeObserver?.disconnect();
      desktop.removeEventListener("change", updateScrollable);
    };
  }, [characters]);

  return (
    <section
      aria-labelledby="dossier-characters-heading"
      className="dossier-panel dossier-character-panel"
    >
      <h2 className="section-heading" id="dossier-characters-heading">
        Connected characters
      </h2>
      {isScrollable ? (
        <p className="dossier-scroll-hint" id="dossier-characters-scroll-hint">
          Scroll to see more connected characters when available.
        </p>
      ) : null}
      <ul
        aria-describedby={
          isScrollable ? "dossier-characters-scroll-hint" : undefined
        }
        aria-labelledby="dossier-characters-heading"
        className="dossier-character-list"
        ref={listRef}
        tabIndex={isScrollable ? 0 : undefined}
      >
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
