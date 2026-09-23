"use client";

import { safeApiErrorSchema, type DossierCharacter } from "@slashwho/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { closeDialog, openDialog, supportsModalDialog } from "./modal-dialog";

export function HistoricAliasDialog({
  character,
  root,
  open,
  onClose,
  onAdded
}: Readonly<{
  character: DossierCharacter;
  root: DossierCharacter["key"];
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<Element | null>(null);
  const [name, setName] = useState("");
  const [realm, setRealm] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const titleId = `historic-alias-title-${character.key.region}-${character.key.realm}-${character.key.name}`;
  const errorId = `${titleId}-error`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    returnFocusRef.current = document.activeElement;
    openDialog(dialog);
    nameRef.current?.focus();
    return () => {
      if (dialog.open) closeDialog(dialog);
      if (returnFocusRef.current instanceof HTMLElement)
        returnFocusRef.current.focus();
    };
  }, [open]);

  useEffect(() => {
    if (open) return;
    setName("");
    setRealm("");
    setError("");
    setPending(false);
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (
      !name.trim() ||
      !realm.trim() ||
      /:\/\//.test(name) ||
      /:\/\//.test(realm)
    ) {
      setError("Enter a character name and realm, without a URL.");
      return;
    }
    const alreadyLinked = (character.historicAliases ?? []).some(
      (alias) =>
        alias.name.toLowerCase() === name.trim().toLowerCase() &&
        alias.realm.toLowerCase() === realm.trim().toLowerCase()
    );
    if (alreadyLinked) {
      setError("This historic alias is already linked.");
      return;
    }
    setPending(true);
    try {
      const response = await fetch(
        `/api/dossiers/${root.region}/${root.realm}/${root.name}/historic-aliases`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            character: character.key,
            name: name.trim(),
            realm: realm.trim()
          })
        }
      );
      if (!response.ok) {
        const parsed = safeApiErrorSchema.safeParse(
          await response.json().catch(() => null)
        );
        setError(
          parsed.success
            ? parsed.data.error.message
            : "The historic alias could not be linked."
        );
        return;
      }
      onAdded();
      onClose();
    } catch {
      setError(
        "The historic alias could not be linked. Check your connection."
      );
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
        if (
          event.key !== "Escape" ||
          !dialogRef.current ||
          supportsModalDialog(dialogRef.current)
        )
          return;
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <form className="search-form" noValidate onSubmit={submit}>
        <h2 className="section-heading" id={titleId}>
          Link historic alias to {character.displayName}
        </h2>
        <p>
          Enter a former name and realm in {character.key.region.toUpperCase()}.
        </p>
        <div className="search-field">
          <label htmlFor={`${titleId}-name`}>Character name</label>
          <input
            aria-describedby={error ? errorId : undefined}
            aria-invalid={Boolean(error)}
            autoCapitalize="none"
            autoCorrect="off"
            className="search-input"
            disabled={pending}
            id={`${titleId}-name`}
            name="name"
            onChange={(event) => setName(event.target.value)}
            ref={nameRef}
            spellCheck={false}
            type="text"
            value={name}
          />
        </div>
        <div className="search-field">
          <label htmlFor={`${titleId}-realm`}>Realm</label>
          <input
            aria-describedby={error ? errorId : undefined}
            aria-invalid={Boolean(error)}
            autoCapitalize="none"
            autoCorrect="off"
            className="search-input"
            disabled={pending}
            id={`${titleId}-realm`}
            name="realm"
            onChange={(event) => setRealm(event.target.value)}
            spellCheck={false}
            type="text"
            value={realm}
          />
        </div>
        <p
          className="form-error"
          id={errorId}
          role={error ? "alert" : "status"}
        >
          {error}
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
          <button className="search-button" disabled={pending} type="submit">
            {pending ? "Linking…" : "Link historic alias"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
