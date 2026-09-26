"use client";

import { dossierStartResponseSchema } from "@slashwho/contracts";
import { parseApplicantCharacterUrl } from "@slashwho/domain";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { dossierStartApiPath } from "../lib/dossier-api";
import { dossierPath, warcraftLogsCharacterUrl } from "../lib/dossier-path";
import { refusalMessage } from "../lib/refusal-message";
import {
  CharacterIdentityFields,
  emptyCharacterIdentity,
  isUnresolvedCharacterIdUrl
} from "./character-identity-fields";

const invalidStructuredUrlMessage =
  "Enter a valid character URL, or character name, realm, and region.";

export function SearchForm() {
  const router = useRouter();
  const [identity, setIdentity] = useState(emptyCharacterIdentity);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { character, name, realm, region } = identity;

  function resetFields() {
    // The region is a standing preference rather than part of the query.
    setIdentity({ ...emptyCharacterIdentity, region });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    // The fields are still resolving a pasted ID URL, or showing why they
    // could not; either way there is no realm or region to submit yet.
    if (isUnresolvedCharacterIdUrl(character)) return;

    let identity: ReturnType<typeof parseApplicantCharacterUrl>;
    try {
      identity = parseApplicantCharacterUrl(character.trim());
    } catch {
      try {
        identity = parseApplicantCharacterUrl(
          warcraftLogsCharacterUrl({ region, realm, name })
        );
      } catch {
        setError(invalidStructuredUrlMessage);
        return;
      }
    }

    const canonicalCharacterUrl = warcraftLogsCharacterUrl(identity);

    setPending(true);
    try {
      const response = await fetch(dossierStartApiPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterUrl: canonicalCharacterUrl })
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(
          refusalMessage(
            response,
            body,
            "The search could not be started. Please try again.",
            "searches"
          )
        );
        return;
      }
      const parsed = dossierStartResponseSchema.safeParse(body);
      if (!parsed.success) {
        setError(
          "The search returned an unexpected response. Please try again."
        );
        return;
      }
      if (parsed.data.kind === "job") {
        router.push(
          `${dossierPath(identity)}?job=${encodeURIComponent(parsed.data.jobId)}`
        );
        resetFields();
        return;
      }
      router.push(dossierPath(identity));
      resetFields();
    } catch {
      setError(
        "The search could not be started. Please check your connection."
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="search-form" onSubmit={submit} noValidate>
      <CharacterIdentityFields
        disabled={pending}
        errorId={error ? "character-search-error" : undefined}
        idPrefix="character"
        invalid={error !== null}
        onChange={(next) => {
          setIdentity(next);
          setError(null);
        }}
        value={identity}
      >
        <button
          className="search-button"
          type="submit"
          aria-label="Research applicant"
          title="Research applicant"
          disabled={pending}
        >
          {pending ? (
            "…"
          ) : (
            <svg
              className="search-button-icon"
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            >
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m15.5 15.5 5 5" />
            </svg>
          )}
        </button>
      </CharacterIdentityFields>
      <p
        className="form-error"
        id="character-search-error"
        role={error ? "alert" : undefined}
        aria-live="polite"
      >
        {error ?? ""}
      </p>
    </form>
  );
}
