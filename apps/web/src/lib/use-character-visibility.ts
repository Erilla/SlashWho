"use client";

import type { CharacterKey, DossierCharacter } from "@slashwho/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { characterId } from "./character-visibility";

const storagePrefix = "slashwho:dossier-hidden-characters:";

function storageKey(rootId: string): string {
  return `${storagePrefix}${rootId}`;
}

/**
 * The stored set, or an empty one. Storage can be absent, blocked or hold
 * something another version wrote, and none of that may break the page.
 */
function readHidden(rootId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(storageKey(rootId)) ?? "[]"
    );
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : []
    );
  } catch {
    return new Set();
  }
}

function writeHidden(rootId: string, hidden: ReadonlySet<string>) {
  try {
    if (hidden.size === 0) window.localStorage.removeItem(storageKey(rootId));
    else
      window.localStorage.setItem(
        storageKey(rootId),
        JSON.stringify([...hidden])
      );
  } catch {
    // A viewer convenience: without storage the filter lasts the visit.
  }
}

export type CharacterVisibilityControls = Readonly<{
  hidden: ReadonlySet<string>;
  /**
   * Whether a listed character with evidence is hidden. The stored set can
   * outlive a character, so its size alone says nothing about the page.
   */
  anyHidden: boolean;
  isHidden: (key: CharacterKey) => boolean;
  toggle: (key: CharacterKey) => void;
  showOnly: (key: CharacterKey) => void;
  hideOnly: (key: CharacterKey) => void;
  showAll: () => void;
}>;

/**
 * Which of a dossier's characters this viewer has hidden from the evidence.
 * It is the viewer's own view, kept in their browser per dossier and never
 * sent anywhere; the dossier's shared exclusions are a separate thing. It
 * holds the hidden set, so a character linked later starts visible.
 */
export function useCharacterVisibility(
  root: CharacterKey,
  characters: readonly DossierCharacter[]
): CharacterVisibilityControls {
  const rootId = characterId(root);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());

  // Read after mount: the server renders without storage, and reading during
  // the first render would make the client's markup disagree with it.
  useEffect(() => {
    setHidden(readHidden(rootId));
  }, [rootId]);

  const update = useCallback(
    (next: ReadonlySet<string>) => {
      setHidden(next);
      writeHidden(rootId, next);
    },
    [rootId]
  );

  // An excluded character has no evidence to hide, and one the reviewer
  // includes again should come back visible, so exclusion clears its entry.
  useEffect(() => {
    const excluded = characters
      .filter((character) => character.excluded)
      .map((character) => characterId(character.key))
      .filter((id) => hidden.has(id));
    if (excluded.length === 0) return;
    const next = new Set(hidden);
    for (const id of excluded) next.delete(id);
    update(next);
  }, [characters, hidden, update]);

  const anyHidden = characters.some(
    (character) => !character.excluded && hidden.has(characterId(character.key))
  );

  const others = useCallback(
    (key: CharacterKey) =>
      characters
        .filter((character) => !character.excluded)
        .map((character) => characterId(character.key))
        .filter((id) => id !== characterId(key)),
    [characters]
  );

  return useMemo(
    () => ({
      hidden,
      anyHidden,
      isHidden: (key) => hidden.has(characterId(key)),
      toggle: (key) => {
        const next = new Set(hidden);
        const id = characterId(key);
        if (!next.delete(id)) next.add(id);
        update(next);
      },
      showOnly: (key) => update(new Set(others(key))),
      hideOnly: (key) => update(new Set([characterId(key)])),
      showAll: () => update(new Set())
    }),
    [anyHidden, hidden, others, update]
  );
}
