"use client";

import { warcraftLogsCharacterResolutionSchema } from "@slashwho/contracts";
import {
  parseApplicantCharacterUrl,
  parseWarcraftLogsCharacterIdUrl,
  supportedRegions,
  type Region
} from "@slashwho/domain";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import {
  credentialHeaders,
  readStoredCredentials
} from "../lib/api-credentials";

export type CharacterIdentity = Readonly<{
  /** What the viewer typed: either a character name or a full character URL. */
  character: string;
  name: string;
  realm: string;
  region: Region;
}>;

export const defaultCharacterRegion: Region = "eu";

export const emptyCharacterIdentity: CharacterIdentity = {
  character: "",
  name: "",
  realm: "",
  region: defaultCharacterRegion
};

/**
 * Resolves what the viewer typed into an identity. A recognised character URL
 * fills the realm and region for them; anything else is taken as the name so
 * they can complete the other fields by hand.
 */
export function readCharacterIdentity(
  value: string,
  previous: CharacterIdentity
): CharacterIdentity {
  try {
    const identity = parseApplicantCharacterUrl(value.trim());
    return {
      character: identity.name,
      name: identity.name,
      realm: identity.realm,
      region: identity.region
    };
  } catch {
    return { ...previous, character: value, name: value };
  }
}

/**
 * Whether what the viewer typed is a Warcraft Logs character-ID URL that has
 * not been resolved yet. Such a URL names no realm or region, so a form must
 * wait for the fields to resolve it rather than submit it.
 */
export function isUnresolvedCharacterIdUrl(character: string): boolean {
  return parseWarcraftLogsCharacterIdUrl(character.trim()) !== undefined;
}

type CharacterIdLookup =
  | { kind: "character"; identity: CharacterIdentity }
  | { kind: "failed"; message: string };

function lookupFailure(status: number): CharacterIdLookup {
  if (status === 404) {
    return {
      kind: "failed",
      message: "No Warcraft Logs character has that ID."
    };
  }
  if (status === 429) {
    return {
      kind: "failed",
      message: "Too many lookups. Please try again shortly."
    };
  }
  return {
    kind: "failed",
    message:
      "Warcraft Logs could not be reached. Enter the character's name and realm instead."
  };
}

async function lookUpCharacterId(
  characterId: number,
  signal: AbortSignal
): Promise<CharacterIdLookup> {
  let response: Response;
  try {
    response = await fetch(`/api/warcraft-logs/characters/${characterId}`, {
      headers: credentialHeaders(readStoredCredentials()),
      signal
    });
  } catch {
    return lookupFailure(0);
  }
  if (!response.ok) return lookupFailure(response.status);
  const parsed = warcraftLogsCharacterResolutionSchema.safeParse(
    await response.json().catch(() => null)
  );
  if (!parsed.success) return lookupFailure(0);
  const { name, realm, region } = parsed.data;
  return {
    kind: "character",
    identity: { character: name, name, realm, region }
  };
}

export type CharacterIdentityFieldsProps = Readonly<{
  /** Scopes control ids, so more than one instance can share a page. */
  idPrefix: string;
  value: CharacterIdentity;
  onChange: (next: CharacterIdentity) => void;
  errorId?: string;
  invalid?: boolean;
  disabled?: boolean;
  /** Lets a dialog move initial focus to the first field. */
  characterRef?: Ref<HTMLInputElement>;
  /** Trailing action rendered beside the region control. */
  children?: ReactNode;
}>;

export function CharacterIdentityFields({
  characterRef,
  children,
  disabled,
  errorId,
  idPrefix,
  invalid,
  onChange,
  value
}: CharacterIdentityFieldsProps) {
  const pastedCharacterId = parseWarcraftLogsCharacterIdUrl(
    value.character.trim()
  );
  const [failedLookup, setFailedLookup] = useState<
    { characterId: number; message: string } | undefined
  >();
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (pastedCharacterId === undefined) return;
    // Aborted when the reviewer types over the URL, so a slow answer for an
    // abandoned paste never overwrites what they went on to enter.
    const controller = new AbortController();
    void lookUpCharacterId(pastedCharacterId, controller.signal).then(
      (lookup) => {
        if (controller.signal.aborted) return;
        if (lookup.kind === "failed") {
          setFailedLookup({
            characterId: pastedCharacterId,
            message: lookup.message
          });
          return;
        }
        onChangeRef.current(lookup.identity);
      }
    );
    return () => {
      controller.abort();
      // A failure belongs to one paste: pasting the same ID again retries.
      setFailedLookup(undefined);
    };
  }, [pastedCharacterId]);

  const lookupError =
    failedLookup && failedLookup.characterId === pastedCharacterId
      ? failedLookup.message
      : undefined;
  const resolving = pastedCharacterId !== undefined && !lookupError;
  const lookupErrorId = `${idPrefix}-lookup-error`;

  // Realm and region are meaningless until there is a character to qualify,
  // and an idle row of empty inputs is what #148 removes from the panel. An
  // ID URL names neither, so they wait for Warcraft Logs to supply them.
  const showStructuredFields =
    value.character.trim() !== "" && pastedCharacterId === undefined;
  const describedBy = errorId ?? undefined;
  const ariaInvalid = invalid === true ? true : undefined;

  return (
    <div
      className={
        showStructuredFields
          ? "search-structured-grid"
          : "search-structured-grid search-structured-grid-collapsed"
      }
    >
      <div className="search-field">
        <input
          className="search-input"
          id={`${idPrefix}-name`}
          name="characterName"
          type="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Character/URL"
          aria-label="Character/URL"
          ref={characterRef}
          value={value.character}
          onChange={(event) =>
            onChange(readCharacterIdentity(event.currentTarget.value, value))
          }
          aria-invalid={lookupError ? true : ariaInvalid}
          aria-describedby={lookupError ? lookupErrorId : describedBy}
          aria-busy={resolving ? true : undefined}
          disabled={disabled}
        />
        {resolving ? (
          <svg
            aria-label="Looking up Warcraft Logs character"
            className="dossier-loading-spinner search-input-spinner"
            role="status"
            viewBox="0 0 24 24"
          >
            <circle cx="12" cy="12" r="8" />
          </svg>
        ) : null}
        {lookupError ? (
          <p className="form-error" id={lookupErrorId} role="alert">
            {lookupError}
          </p>
        ) : null}
      </div>
      {showStructuredFields ? (
        <div className="search-field">
          <input
            className="search-input"
            id={`${idPrefix}-realm`}
            name="characterRealm"
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Realm"
            aria-label="Realm"
            value={value.realm}
            onChange={(event) =>
              onChange({
                ...value,
                realm: event.currentTarget.value,
                name: value.character
              })
            }
            aria-invalid={ariaInvalid}
            aria-describedby={describedBy}
            disabled={disabled}
          />
        </div>
      ) : null}
      <div className="search-field search-region-field">
        {showStructuredFields ? (
          <select
            className="search-select"
            id={`${idPrefix}-region`}
            name="characterRegion"
            aria-label="Region"
            value={value.region}
            onChange={(event) =>
              onChange({
                ...value,
                region: event.currentTarget.value as Region,
                name: value.character
              })
            }
            aria-invalid={ariaInvalid}
            aria-describedby={describedBy}
            disabled={disabled}
          >
            {supportedRegions.map((supportedRegion) => (
              <option key={supportedRegion} value={supportedRegion}>
                {supportedRegion.toUpperCase()}
              </option>
            ))}
          </select>
        ) : null}
        {children}
      </div>
    </div>
  );
}
