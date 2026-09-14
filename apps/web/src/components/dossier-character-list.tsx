import type { DossierCharacter } from "@slashwho/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { DossierCharacterName } from "./dossier-character-name";
import { CharacterProfileLinks } from "./profile-links";

type DossierCharacterListProps = Readonly<{
  characters: readonly DossierCharacter[];
  root: DossierCharacter["key"];
}>;

function isRoot(character: DossierCharacter, root: DossierCharacter["key"]) {
  return (
    character.key.region.toLocaleLowerCase("en-US") ===
      root.region.toLocaleLowerCase("en-US") &&
    character.key.realm.toLocaleLowerCase("en-US") ===
      root.realm.toLocaleLowerCase("en-US") &&
    character.key.name.toLocaleLowerCase("en-US") ===
      root.name.toLocaleLowerCase("en-US")
  );
}

const sourceLabel: Record<DossierCharacter["source"], string> = {
  submitted: "Submitted character",
  raiderio_declared: "Raider.IO declared",
  fingerprint_derived: "Fingerprint-derived",
  manually_added: "Manually added"
};

export function DossierCharacterList({
  characters,
  root
}: DossierCharacterListProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const [isScrollable, setIsScrollable] = useState(false);
  const [characterUrl, setCharacterUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function addCharacter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch(
      `/api/dossiers/${root.region}/${root.realm}/${root.name}/connected-characters`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterUrl })
      }
    );
    if (response.status === 202) {
      setMessage("Researching connected character…");
      return;
    }
    if (!response.ok) {
      setMessage("The character could not be added.");
      return;
    }
    window.location.reload();
  }

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
              <DossierCharacterName character={character} />
              <span className="dossier-location">
                {character.key.region.toUpperCase()} · {character.key.realm}
              </span>
            </div>
            <div className="dossier-character-actions">
              {isRoot(character, root) ? null : (
                <CharacterProfileLinks character={character} />
              )}
              <span className="source-badge">
                {sourceLabel[character.source]}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <form className="search-form" onSubmit={addCharacter}>
        <label className="visually-hidden" htmlFor="connected-character-url">
          Connected character URL
        </label>
        <div className="search-control">
          <input
            className="search-input"
            id="connected-character-url"
            type="url"
            value={characterUrl}
            onChange={(event) => setCharacterUrl(event.currentTarget.value)}
            placeholder="Raider.IO or Warcraft Logs character URL"
            required
          />
          <button className="search-button" type="submit">
            Add character
          </button>
        </div>
        {message ? (
          <p className="form-error" role="status">
            {message}
          </p>
        ) : null}
      </form>
    </section>
  );
}
