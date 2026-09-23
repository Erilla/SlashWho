"use client";

import type { CharacterKey, DossierCharacter } from "@slashwho/contracts";
import { formatCharacterDisplayName } from "@slashwho/domain";
import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useId
} from "react";

import { CharacterProfileLinks } from "./profile-links";

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
): Readonly<{
  displayName: string;
  className: string | null;
  guild?: DossierCharacter["guild"];
  historicAliases?: DossierCharacter["historicAliases"];
}> {
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
  character,
  className: additionalClassName,
  showGuild = false
}: Readonly<{
  character: CharacterReference;
  className?: string;
  /**
   * Off by default. This component also renders names inline in parse, kill and
   * wipe rows, where a guild on every mention would bury the evidence beside it,
   * so only the character list asks for one.
   */
  showGuild?: boolean;
}>) {
  const characters = useContext(DossierCharactersContext);
  const resolved = resolveCharacter(character, characters);
  const tooltipId = useId();
  const historicAliases = showGuild ? (resolved.historicAliases ?? []) : [];
  const modifier = colourClass(resolved.className);
  const className = [
    modifier
      ? `dossier-character-name dossier-character-name--${modifier}`
      : "dossier-character-name",
    additionalClassName
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <span
        className={
          historicAliases.length ? "dossier-character-alias-anchor" : undefined
        }
      >
        <span
          aria-describedby={historicAliases.length ? tooltipId : undefined}
          className={className}
          tabIndex={historicAliases.length ? 0 : undefined}
        >
          {formatCharacterDisplayName(resolved.displayName)}
        </span>
        {historicAliases.length ? (
          <span
            className="dossier-character-alias-tooltip"
            id={tooltipId}
            role="tooltip"
          >
            Also known as:{" "}
            {historicAliases
              .map(
                (alias) =>
                  `${formatCharacterDisplayName(alias.name)}-${formatCharacterDisplayName(alias.realm)}`
              )
              .join(", ")}
          </span>
        ) : null}
      </span>
      {showGuild && resolved.guild ? (
        <span className="dossier-character-guild">
          {`<${resolved.guild.name}>`}
        </span>
      ) : null}
    </>
  );
}

export function DossierCharacterNameByName({
  name
}: Readonly<{ name: string }>) {
  const characters = useContext(DossierCharactersContext);
  const normalizedName = name.trim().toLowerCase();
  const matches = characters.filter(
    (character) =>
      character.displayName.trim().toLowerCase() === normalizedName ||
      character.key.name.trim().toLowerCase() === normalizedName
  );
  const character = matches.length === 1 ? matches[0] : null;

  return character ? (
    <DossierCharacterName
      character={character}
      className="dossier-parse-character"
    />
  ) : (
    <span className="dossier-character-name dossier-parse-character">
      {formatCharacterDisplayName(name)}
    </span>
  );
}

export function DossierCharacterNames({
  characters,
  empty = "—"
}: Readonly<{ characters: readonly CharacterKey[]; empty?: string }>) {
  const dossierCharacters = useContext(DossierCharactersContext);
  if (characters.length === 0) return <>{empty}</>;

  return (
    <>
      {characters.map((character, index) => (
        <Fragment
          key={`${character.region}/${character.realm}/${character.name}`}
        >
          {index > 0 ? ", " : null}
          <DossierCharacterName character={character} />
          <CharacterProfileLinks
            character={{
              key: character,
              displayName: resolveCharacter(character, dossierCharacters)
                .displayName
            }}
          />
        </Fragment>
      ))}
    </>
  );
}
