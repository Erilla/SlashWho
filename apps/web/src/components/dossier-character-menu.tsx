"use client";

import { safeApiErrorSchema, type DossierCharacter } from "@slashwho/contracts";
import type { CharacterKey } from "@slashwho/domain";
import { useEffect, useRef, useState } from "react";

import { closeDialog, openDialog, supportsModalDialog } from "./modal-dialog";
import { HistoricAliasDialog } from "./historic-alias-dialog";

const unreachableMessage =
  "The character could not be updated. Please check your connection.";
const failedMessage = "The character could not be updated.";

type Status =
  Readonly<{ kind: "idle" }> | Readonly<{ kind: "error"; message: string }>;

function refusalMessage(response: Response, body: unknown): string {
  const parsed = safeApiErrorSchema.safeParse(body);
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    return retryAfter && /^\d+$/.test(retryAfter)
      ? `Too many requests. Try again in ${retryAfter} seconds.`
      : "Too many requests. Please try again shortly.";
  }
  return parsed.success ? parsed.data.error.message : failedMessage;
}

/** What a row action did, so the dossier can announce it in its own words. */
export type ConnectedCharacterChange = Readonly<{
  key: CharacterKey;
  displayName: string;
  kind: "excluded" | "included" | "removed" | "alias_added" | "alias_removed";
}>;

export type DossierCharacterMenuProps = Readonly<{
  character: DossierCharacter;
  root: CharacterKey;
  /** Reports a change so the dossier can refresh and announce it. */
  onChanged?: (change: ConnectedCharacterChange) => void;
}>;

/**
 * The per-character actions a reviewer has over a manually added character:
 * excluding it from the evidence, restoring it, and unlinking it for good.
 * Source-discovered characters have no such actions, so the connected list
 * renders this only for a manual link.
 */
export function DossierCharacterMenu({
  character,
  onChanged,
  root
}: DossierCharacterMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [linkingAlias, setLinkingAlias] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const titleId = `dossier-character-remove-${character.key.region}-${character.key.realm}-${character.key.name}`;

  // A menu left open behind a click elsewhere hides the rest of the row, so
  // anything outside it closes it. Focus stays where the viewer put it.
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
    if (open) firstItemRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !confirming) return;

    openDialog(dialog);

    return () => {
      if (dialog.open) closeDialog(dialog);
    };
  }, [confirming]);

  function dismiss() {
    setOpen(false);
    setConfirming(false);
    setLinkingAlias(false);
    triggerRef.current?.focus();
  }

  async function removeAlias(alias: CharacterKey) {
    setPending(true);
    setStatus({ kind: "idle" });
    try {
      const response = await fetch(
        `/api/dossiers/${root.region}/${root.realm}/${root.name}/historic-aliases`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            character: character.key,
            name: alias.name,
            realm: alias.realm
          })
        }
      );
      if (!response.ok) {
        const parsed = safeApiErrorSchema.safeParse(
          await response.json().catch(() => null)
        );
        setStatus({
          kind: "error",
          message: parsed.success ? parsed.data.error.message : failedMessage
        });
        return;
      }
      dismiss();
      onChanged?.({
        key: character.key,
        displayName: character.displayName,
        kind: "alias_removed"
      });
    } catch {
      setStatus({ kind: "error", message: unreachableMessage });
    } finally {
      setPending(false);
    }
  }

  async function send(
    method: "PATCH" | "DELETE",
    body: Record<string, unknown>,
    change: ConnectedCharacterChange["kind"]
  ) {
    setPending(true);
    setStatus({ kind: "idle" });
    try {
      const response = await fetch(
        `/api/dossiers/${root.region}/${root.realm}/${root.name}/connected-characters`,
        {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }
      );
      const responseBody: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setStatus({
          kind: "error",
          message: refusalMessage(response, responseBody)
        });
        return;
      }
      setConfirming(false);
      setOpen(false);
      onChanged?.({
        key: character.key,
        displayName: character.displayName,
        kind: change
      });
    } catch {
      setStatus({ kind: "error", message: unreachableMessage });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="dossier-character-menu">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Actions for ${character.displayName}`}
        className="dossier-character-menu-trigger"
        onClick={() => {
          setStatus({ kind: "idle" });
          setOpen((wasOpen) => !wasOpen);
        }}
        ref={triggerRef}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle cx="12" cy="5" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="12" cy="19" r="1.75" />
        </svg>
      </button>
      {open ? (
        <div
          className="dossier-character-menu-items"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              dismiss();
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            const items = Array.from(
              menuRef.current?.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]:not(:disabled)'
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
            disabled={pending}
            onClick={() =>
              void send(
                "PATCH",
                {
                  characterUrl: character.raiderIoUrl,
                  excluded: character.excluded !== true
                },
                character.excluded ? "included" : "excluded"
              )
            }
            ref={firstItemRef}
            role="menuitem"
            type="button"
          >
            {character.excluded ? "Include" : "Exclude"}
          </button>
          <button
            className="dossier-character-menu-item"
            disabled={pending}
            onClick={() => {
              setOpen(false);
              setLinkingAlias(true);
            }}
            role="menuitem"
            type="button"
          >
            Link historic alias…
          </button>
          {(character.historicAliases ?? []).map((alias) => (
            <button
              className="dossier-character-menu-item"
              disabled={pending}
              key={`${alias.region}/${alias.realm}/${alias.name}`}
              onClick={() => void removeAlias(alias)}
              role="menuitem"
              type="button"
            >
              Remove historic alias {alias.name}-{alias.realm}
            </button>
          ))}
          {character.source === "manually_added" ? (
            <button
              className="dossier-character-menu-item dossier-character-menu-item--destructive"
              disabled={pending}
              onClick={() => setConfirming(true)}
              role="menuitem"
              type="button"
            >
              Remove…
            </button>
          ) : null}
        </div>
      ) : null}
      {status.kind === "error" ? (
        <p className="form-error dossier-character-menu-error" role="alert">
          {status.message}
        </p>
      ) : null}
      {confirming ? (
        <dialog
          aria-labelledby={titleId}
          className="dossier-character-remove-dialog"
          onCancel={(event) => {
            event.preventDefault();
            dismiss();
          }}
          onKeyDown={(event) => {
            // Only the fallback path needs this; showModal raises cancel itself.
            const dialog = dialogRef.current;
            if (
              event.key !== "Escape" ||
              !dialog ||
              supportsModalDialog(dialog)
            ) {
              return;
            }
            event.preventDefault();
            dismiss();
          }}
          ref={dialogRef}
        >
          <h2 className="section-heading" id={titleId}>
            Remove connected character
          </h2>
          <p>
            Remove {character.displayName} ({character.key.region.toUpperCase()}{" "}
            · {character.key.realm}) from this dossier? Its evidence goes with
            it. The character and every snapshot that found it are left alone,
            and it can be added again.
          </p>
          <div className="dossier-character-add-actions">
            <button
              className="search-button"
              disabled={pending}
              onClick={dismiss}
              type="button"
            >
              Cancel
            </button>
            <button
              className="search-button"
              disabled={pending}
              onClick={() =>
                void send(
                  "DELETE",
                  { characterUrl: character.raiderIoUrl },
                  "removed"
                )
              }
              type="button"
            >
              {pending ? "Removing…" : "Remove character"}
            </button>
          </div>
        </dialog>
      ) : null}
      <HistoricAliasDialog
        character={character}
        root={root}
        open={linkingAlias}
        onClose={() => {
          setLinkingAlias(false);
          triggerRef.current?.focus();
        }}
        onAdded={() =>
          onChanged?.({
            key: character.key,
            displayName: character.displayName,
            kind: "alias_added"
          })
        }
      />
    </div>
  );
}
