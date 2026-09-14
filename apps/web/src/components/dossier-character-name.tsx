"use client";

import type { CharacterKey, DossierCharacter } from "@slashwho/contracts";
import { formatCharacterDisplayName } from "@slashwho/domain";
import { createContext, Fragment, type ReactNode, useContext } from "react";

type CharacterReference = DossierCharacter | CharacterKey;

const DossierCharactersContext = createContext<readonly DossierCharacter[]>([]);

const classColourClass: Readonly<Record<string, string>> = {
  deathknight: "death-knight",
  demonhunter: "demon-hunter",
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

function sameCharacter(left: CharacterKey, right: CharacterKey): boolean {
  return (
    left.region === right.region &&
    left.realm.toLowerCase() === right.realm.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
}

function resolveCharacter(
  reference: CharacterReference,
  characters: readonly DossierCharacter[]
): Readonly<{ displayName: string; className: string | null }> {
  if ("displayName" in reference) return reference;

  return (
    characters.find((character) => sameCharacter(character.key, reference)) ?? {
      displayName: reference.name,
      className: null
    }
  );
}

function colourClass(className: string | null): string | null {
  const normalized = className
    ?.trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return normalized ? (classColourClass[normalized] ?? null) : null;
}

export function DossierCharacterProvider({
  characters,
  children
}: Readonly<{
  characters: readonly DossierCharacter[];
  children: ReactNode;
}>) {
  return (
    <DossierCharactersContext.Provider value={characters}>
      {children}
    </DossierCharactersContext.Provider>
  );
}

export function DossierCharacterName({
  character
}: Readonly<{ character: CharacterReference }>) {
  const characters = useContext(DossierCharactersContext);
  const resolved = resolveCharacter(character, characters);
  const modifier = colourClass(resolved.className);
  const className = modifier
    ? `dossier-character-name dossier-character-name--${modifier}`
    : "dossier-character-name";

  return (
    <span className={className}>
      {formatCharacterDisplayName(resolved.displayName)}
    </span>
  );
}

export function DossierCharacterNames({
  characters,
  empty = "—"
}: Readonly<{ characters: readonly CharacterKey[]; empty?: string }>) {
  if (characters.length === 0) return <>{empty}</>;

  return (
    <>
      {characters.map((character, index) => (
        <Fragment
          key={`${character.region}/${character.realm}/${character.name}`}
        >
          {index > 0 ? ", " : null}
          <DossierCharacterName character={character} />
        </Fragment>
      ))}
    </>
  );
}
