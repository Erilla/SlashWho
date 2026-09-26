"use client";

import type { DossierCharacter } from "@slashwho/contracts";
import { formatCharacterDisplayName } from "@slashwho/domain";
import { useEffect, useRef, useState } from "react";

export type DossierCharacterVisibilityToggleProps = Readonly<{
  character: DossierCharacter;
  hidden: boolean;
  /** Whether any character is hidden, so the menu can offer to show them all. */
  anyHidden: boolean;
  onToggle: () => void;
  onShowOnly: () => void;
  onHideOnly: () => void;
  onShowAll: () => void;
}>;

function EyeIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {hidden ? <path d="M4 4l16 16" /> : null}
    </svg>
  );
}

/**
 * The eye at the start of a connected-character row. It only changes what
 * this viewer sees of the evidence; the dossier's own exclusions are in the
 * row menu. A click toggles the character, and the context menu (right click,
 * or the keyboard's menu key) narrows the view to or away from it.
 */
export function DossierCharacterVisibilityToggle({
  anyHidden,
  character,
  hidden,
  onHideOnly,
  onShowAll,
  onShowOnly,
  onToggle
}: DossierCharacterVisibilityToggleProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const name = formatCharacterDisplayName(character.displayName);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (open)
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus();
  }, [open]);

  function choose(action: () => void) {
    setOpen(false);
    action();
    triggerRef.current?.focus();
  }

  if (character.excluded) {
    return (
      <button
        aria-label={`${name} is excluded, so has no evidence to show`}
        className="dossier-character-visibility-trigger"
        disabled
        type="button"
      >
        <EyeIcon hidden />
      </button>
    );
  }

  return (
    <div className="dossier-character-visibility">
      <button
        aria-label={`Show ${name} in the evidence`}
        aria-pressed={!hidden}
        className="dossier-character-visibility-trigger"
        onClick={onToggle}
        onContextMenu={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
        ref={triggerRef}
        title="Show or hide this character's evidence. Right-click for more."
        type="button"
      >
        <EyeIcon hidden={hidden} />
      </button>
      {open ? (
        <div
          aria-label={`Evidence visibility for ${name}`}
          className="dossier-character-menu-items dossier-character-visibility-items"
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") {
              if (event.key === "Escape") event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              triggerRef.current?.focus();
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            const items = Array.from(
              menuRef.current?.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]'
              ) ?? []
            );
            if (items.length === 0) return;
            event.preventDefault();
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : event.key === "ArrowDown"
                    ? (index + 1) % items.length
                    : (index - 1 + items.length) % items.length;
            items[next]?.focus();
          }}
          ref={menuRef}
          role="menu"
        >
          <button
            className="dossier-character-menu-item"
            onClick={() => choose(onToggle)}
            role="menuitem"
            type="button"
          >
            {hidden ? `Show ${name}` : `Hide ${name}`}
          </button>
          <button
            className="dossier-character-menu-item"
            onClick={() => choose(onShowOnly)}
            role="menuitem"
            type="button"
          >
            Show only {name}
          </button>
          <button
            className="dossier-character-menu-item"
            onClick={() => choose(onHideOnly)}
            role="menuitem"
            type="button"
          >
            Hide only {name}
          </button>
          {anyHidden ? (
            <button
              className="dossier-character-menu-item"
              onClick={() => choose(onShowAll)}
              role="menuitem"
              type="button"
            >
              Show all characters
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
