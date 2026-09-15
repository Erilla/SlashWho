"use client";

import {
  dossierStartResponseSchema,
  safeApiErrorSchema
} from "@slashwho/contracts";
import {
  parseApplicantCharacterUrl,
  type CharacterKey
} from "@slashwho/domain";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  CharacterIdentityFields,
  emptyCharacterIdentity,
  type CharacterIdentity
} from "./character-identity-fields";

const titleId = "add-connected-character-title";
const statusId = "add-connected-character-status";

const invalidCharacterMessage =
  "Enter a valid character URL, or character name, realm, and region.";
const unreachableMessage =
  "The character could not be added. Please check your connection.";

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
  if (parsed.success) return parsed.data.error.message;
  return "The character could not be added.";
}

/** Resolves what the viewer entered, falling back to the structured fields. */
function resolveIdentity(identity: CharacterIdentity): CharacterKey | null {
  try {
    return parseApplicantCharacterUrl(identity.character.trim());
  } catch {
    try {
      return parseApplicantCharacterUrl(
        `https://www.warcraftlogs.com/character/${identity.region}/${encodeURIComponent(identity.realm)}/${encodeURIComponent(identity.name)}`
      );
    } catch {
      return null;
    }
  }
}

/**
 * jsdom, and browsers without dialog support, implement neither showModal nor
 * close. showModal gives the top layer, an inert backdrop and Escape handling
 * where it exists; the open attribute is the honest fallback everywhere else.
 */
function supportsModalDialog(dialog: HTMLDialogElement): boolean {
  return typeof dialog.showModal === "function";
}

function openDialog(dialog: HTMLDialogElement): void {
  if (supportsModalDialog(dialog)) dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function sameCharacter(left: CharacterKey, right: CharacterKey): boolean {
  return (
    left.region === right.region &&
    left.realm === right.realm &&
    left.name === right.name
  );
}

function displayName(key: CharacterKey): string {
  return key.name.charAt(0).toLocaleUpperCase("en-US") + key.name.slice(1);
}

export type AddedConnectedCharacter = Readonly<{
  key: CharacterKey;
  /** True while the character still has to be discovered. */
  queued: boolean;
}>;

export type AddConnectedCharacterDialogProps = Readonly<{
  open: boolean;
  root: CharacterKey;
  connectedCharacters: readonly CharacterKey[];
  onClose: () => void;
  /** Reports the addition so the dossier can refresh and announce it. */
  onAdded: (added: AddedConnectedCharacter) => void;
}>;

export function AddConnectedCharacterDialog({
  connectedCharacters,
  onAdded,
  onClose,
  open,
  root
}: AddConnectedCharacterDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const characterFieldRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<Element | null>(null);
  const [identity, setIdentity] = useState(emptyCharacterIdentity);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;

    returnFocusRef.current = document.activeElement;
    openDialog(dialog);
    characterFieldRef.current?.focus();

    return () => {
      if (dialog.open) closeDialog(dialog);
      const returnFocus = returnFocusRef.current;
      if (returnFocus instanceof HTMLElement) returnFocus.focus();
    };
  }, [open]);

  // Reopening should not show the previous attempt's entry or outcome.
  useEffect(() => {
    if (!open) {
      setIdentity(emptyCharacterIdentity);
      setStatus({ kind: "idle" });
      setPending(false);
    }
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus({ kind: "idle" });

    const key = resolveIdentity(identity);
    if (!key) {
      setStatus({ kind: "error", message: invalidCharacterMessage });
      return;
    }
    if (sameCharacter(key, root)) {
      setStatus({
        kind: "error",
        message: `${displayName(key)} is the character this dossier is about.`
      });
      return;
    }
    // A duplicate answers with the same ready response as a fresh link, so
    // saying so here is the only way the viewer learns nothing changed.
    if (
      connectedCharacters.some((character) => sameCharacter(key, character))
    ) {
      setStatus({
        kind: "error",
        message: `${displayName(key)} is already connected to this dossier.`
      });
      return;
    }

    setPending(true);
    try {
      const response = await fetch(
        `/api/dossiers/${root.region}/${root.realm}/${root.name}/connected-characters`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            characterUrl: `https://www.warcraftlogs.com/character/${key.region}/${key.realm}/${key.name}`
          })
        }
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setStatus({ kind: "error", message: refusalMessage(response, body) });
        return;
      }
      const parsed = dossierStartResponseSchema.safeParse(body);
      if (!parsed.success) {
        setStatus({
          kind: "error",
          message: "The character could not be added."
        });
        return;
      }
      // Both outcomes link the character, so both close. A queued one appears
      // in the connected list with its research spinner rather than holding
      // the viewer in a dialog whose Cancel could not cancel anything.
      onAdded({ key, queued: parsed.data.kind === "job" });
      onClose();
    } catch {
      setStatus({ kind: "error", message: unreachableMessage });
    } finally {
      setPending(false);
    }
  }

  if (!open) return null;

  return (
    <dialog
      aria-labelledby={titleId}
      className="dossier-character-add-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        // Only the fallback path needs this; showModal raises cancel itself.
        const dialog = dialogRef.current;
        if (event.key !== "Escape" || !dialog || supportsModalDialog(dialog)) {
          return;
        }
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <form className="search-form" noValidate onSubmit={submit}>
        <h2 className="section-heading" id={titleId}>
          Add connected character
        </h2>
        <CharacterIdentityFields
          characterRef={characterFieldRef}
          disabled={pending}
          errorId={status.kind === "idle" ? undefined : statusId}
          idPrefix="connected-character"
          invalid={status.kind === "error"}
          onChange={(next) => {
            setIdentity(next);
            setStatus({ kind: "idle" });
          }}
          value={identity}
        />
        <p
          className="form-error"
          id={statusId}
          role={status.kind === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {status.kind === "idle" ? "" : status.message}
        </p>
        <div className="dossier-character-add-actions">
          <button
            className="search-button"
            disabled={pending}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            aria-label="Add connected character"
            className="search-button"
            disabled={pending}
            type="submit"
          >
            {pending ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
