import type { DossierCharacter } from "@slashwho/contracts";
import { formatCharacterDisplayName } from "@slashwho/domain";
import { useEffect, useRef, useState } from "react";

import { DossierCharacterName } from "./dossier-character-name";
import { UpstreamIconLink } from "./upstream-icon-link";

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
        className={`dossier-character-list${isScrollable ? " dossier-scrollable" : ""}`}
        ref={listRef}
        tabIndex={isScrollable ? 0 : undefined}
      >
        {characters.map((character) => (
          <li
            className="dossier-character-row"
            key={`${character.key.region}/${character.key.realm}/${character.key.name}`}
          >
            <div>
              <UpstreamIconLink
                href={character.raiderIoUrl}
                label={`View ${formatCharacterDisplayName(character.displayName)} on Raider.IO`}
                source="raiderio"
              >
                <DossierCharacterName character={character} />
              </UpstreamIconLink>
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
