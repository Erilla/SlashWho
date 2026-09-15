"use client";

import {
  parseApplicantCharacterUrl,
  supportedRegions,
  type Region
} from "@slashwho/domain";
import type { ReactNode, Ref } from "react";

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
  // Realm and region are meaningless until there is a character to qualify,
  // and an idle row of empty inputs is what #148 removes from the panel.
  const showStructuredFields = value.character.trim() !== "";
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
          aria-invalid={ariaInvalid}
          aria-describedby={describedBy}
          disabled={disabled}
        />
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
