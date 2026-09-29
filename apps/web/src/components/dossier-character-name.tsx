"use client";

import type { CharacterKey, DossierCharacter } from "@slashwho/contracts";
import { formatCharacterDisplayName } from "@slashwho/domain";
import Link from "next/link";
import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState
} from "react";

import { dossierPath } from "../lib/dossier-path";
import { CharacterProfileLinks } from "./profile-links";

type CharacterReference = DossierCharacter | CharacterKey;

const DossierCharactersContext = createContext<readonly DossierCharacter[]>([]);
// The character whose dossier is on screen. Its name is not linked, because a
// link to the page the reader is already on only reloads it.
const CurrentCharacterContext = createContext<CharacterKey | null>(null);

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
  warcraftLogsAliases?: DossierCharacter["warcraftLogsAliases"];
}> {
  if ("displayName" in reference) return reference;

  return (
    characters.find((character) => sameCharacter(character.key, reference)) ?? {
      displayName: reference.name,
      className: null
    }
  );
}

/** The class-colour modifier for a class name, or null for one without a colour. */
export function classColourModifier(className: string | null): string | null {
  const normalized = className
    ?.trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return normalized ? (classColourClass[normalized] ?? null) : null;
}

function characterKey(reference: CharacterReference): CharacterKey {
  return "displayName" in reference ? reference.key : reference;
}

function identityLabel(identity: CharacterKey): string {
  return `${formatCharacterDisplayName(identity.name)}-${formatCharacterDisplayName(identity.realm)}`;
}

/**
 * An icon after a name that carries what the name cannot: a hover tooltip on
 * the name competed with its link and did not exist on touch. The icon opens
 * on hover, keyboard focus and tap (a tap toggles it, because Safari does not
 * focus a button it is tapped), and Escape or a tap elsewhere closes it.
 */
function IdentityHint({
  label,
  text
}: Readonly<{ label: string; text: string }>) {
  const tooltipId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        event.type === "keydown" &&
        (event as KeyboardEvent).key !== "Escape"
      ) {
        return;
      }
      if (
        event.type === "pointerdown" &&
        rootRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <span className="dossier-identity-hint" ref={rootRef}>
      <button
        aria-describedby={tooltipId}
        aria-expanded={open}
        aria-label={label}
        className="dossier-identity-hint-trigger"
        // Visibility follows this state alone, so Escape and a second tap
        // close it even while the pointer or focus is still on the icon
        // (WCAG 1.4.13). A touch tap is left to onClick, whose emulated
        // mouse events would otherwise open and immediately re-close it.
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((value) => !value)}
        onFocus={(event) => {
          try {
            if (event.currentTarget.matches(":focus-visible")) setOpen(true);
          } catch {
            // A selector the engine does not know: focus alone opens nothing.
          }
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") setOpen(true);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") setOpen(false);
        }}
        type="button"
      >
        <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
          <path
            d="M2.5 8a5.5 5.5 0 1 0 1.7-4M2.5 2.5v2.8h2.8M8 5v3.2l2 1.3"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.5"
          />
        </svg>
      </button>
      <span
        className="dossier-identity-hint-tooltip"
        data-open={open}
        id={tooltipId}
        role="tooltip"
      >
        {text}
      </span>
    </span>
  );
}

export function DossierCharacterProvider({
  characters,
  current = null,
  children
}: Readonly<{
  characters: readonly DossierCharacter[];
  current?: CharacterKey | null;
  children: ReactNode;
}>) {
  return (
    <DossierCharactersContext.Provider value={characters}>
      <CurrentCharacterContext.Provider value={current}>
        {children}
      </CurrentCharacterContext.Provider>
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
  const current = useContext(CurrentCharacterContext);
  const resolved = resolveCharacter(character, characters);
  const key = characterKey(character);
  const href = current && sameCharacter(key, current) ? null : dossierPath(key);
  // A reviewer can declare a name Warcraft Logs has also verified, so the
  // two lists overlap; the tooltip names each former identity once.
  const historicAliases = showGuild
    ? [
        ...(resolved.historicAliases ?? []),
        ...(resolved.warcraftLogsAliases ?? [])
      ].filter(
        (alias, index, all) =>
          all.findIndex((other) => sameCharacter(other, alias)) === index
      )
    : [];
  const modifier = classColourModifier(resolved.className);
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
      {href ? (
        <Link
          className={className}
          href={href}
          // A dossier can name dozens of characters, and each would otherwise
          // prefetch its own dossier route as it scrolls into view.
          prefetch={false}
        >
          {formatCharacterDisplayName(resolved.displayName)}
        </Link>
      ) : (
        <span className={className}>
          {formatCharacterDisplayName(resolved.displayName)}
        </span>
      )}
      {historicAliases.length ? (
        <IdentityHint
          label="Also known as"
          text={`Also known as: ${historicAliases.map(identityLabel).join(", ")}`}
        />
      ) : null}
      {showGuild && resolved.guild ? (
        <span className="dossier-character-guild">
          {`<${resolved.guild.name}>`}
        </span>
      ) : null}
    </>
  );
}

export function DossierCharacterNameByName({
  name,
  loggedAs
}: Readonly<{
  name: string;
  /** Set when the row's parse was logged under a name other than this one. */
  loggedAs?: CharacterKey | undefined;
}>) {
  const characters = useContext(DossierCharactersContext);
  const normalizedName = name.trim().toLowerCase();
  const matches = characters.filter(
    (character) =>
      character.displayName.trim().toLowerCase() === normalizedName ||
      character.key.name.trim().toLowerCase() === normalizedName
  );
  const character = matches.length === 1 ? matches[0] : null;

  const label = character ? (
    <DossierCharacterName
      character={character}
      className="dossier-parse-character"
    />
  ) : (
    <span className="dossier-character-name dossier-parse-character">
      {formatCharacterDisplayName(name)}
    </span>
  );

  // One grid cell in the parse list, so the icon stays with its name.
  return loggedAs ? (
    <span className="dossier-parse-identity">
      {label}
      <IdentityHint
        label="Logged under a former name"
        text={`Logged as ${identityLabel(loggedAs)}`}
      />
    </span>
  ) : (
    label
  );
}

/**
 * Names in their class colours, without links or profile icons: for a
 * surface such as a tooltip, which shows on hover and cannot be clicked.
 */
export function DossierCharacterLabels({
  characters
}: Readonly<{ characters: readonly CharacterKey[] }>) {
  const dossierCharacters = useContext(DossierCharactersContext);

  return (
    <>
      {characters.map((character, index) => {
        const resolved = resolveCharacter(character, dossierCharacters);
        const modifier = classColourModifier(resolved.className);
        return (
          <Fragment
            key={`${character.region}/${character.realm}/${character.name}`}
          >
            {index > 0 ? ", " : null}
            <span
              className={
                modifier
                  ? `dossier-character-name dossier-character-name--${modifier}`
                  : "dossier-character-name"
              }
            >
              {formatCharacterDisplayName(resolved.displayName)}
            </span>
          </Fragment>
        );
      })}
    </>
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
