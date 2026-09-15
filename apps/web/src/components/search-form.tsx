"use client";

import {
  dossierStartResponseSchema,
  safeApiErrorSchema
} from "@slashwho/contracts";
import {
  parseApplicantCharacterUrl,
  supportedRegions,
  type Region
} from "@slashwho/domain";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

const invalidStructuredUrlMessage =
  "Enter a valid character URL, or character name, realm, and region.";
const defaultRegion: Region = "eu";

function errorMessage(response: Response, body: unknown): string {
  const parsed = safeApiErrorSchema.safeParse(body);
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    return retryAfter && /^\d+$/.test(retryAfter)
      ? `Too many searches. Try again in ${retryAfter} seconds.`
      : "Too many searches. Please try again shortly.";
  }
  if (parsed.success) return parsed.data.error.message;
  return "The search could not be started. Please try again.";
}

export function SearchForm() {
  const router = useRouter();
  const [character, setCharacter] = useState("");
  const [name, setName] = useState("");
  const [realm, setRealm] = useState("");
  const [region, setRegion] = useState<Region>(defaultRegion);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const showStructuredFields = character.trim() !== "";

  function resetFields() {
    setCharacter("");
    setName("");
    setRealm("");
  }

  function onCharacterChange(value: string) {
    setCharacter(value);
    try {
      const identity = parseApplicantCharacterUrl(value.trim());
      setCharacter(identity.name);
      setName(identity.name);
      setRealm(identity.realm);
      setRegion(identity.region);
    } catch {
      setName(value);
    }
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    let identity: ReturnType<typeof parseApplicantCharacterUrl>;
    try {
      identity = parseApplicantCharacterUrl(character.trim());
    } catch {
      try {
        identity = parseApplicantCharacterUrl(
          `https://www.warcraftlogs.com/character/${region}/${encodeURIComponent(realm)}/${encodeURIComponent(name)}`
        );
      } catch {
        setError(invalidStructuredUrlMessage);
        return;
      }
    }

    const canonicalCharacterUrl = `https://www.warcraftlogs.com/character/${identity.region}/${identity.realm}/${identity.name}`;

    setPending(true);
    try {
      const response = await fetch("/api/dossiers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterUrl: canonicalCharacterUrl })
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(errorMessage(response, body));
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
          `/dossiers/${identity.region}/${identity.realm}/${identity.name}?job=${parsed.data.jobId}`
        );
        resetFields();
        return;
      }
      router.push(
        `/dossiers/${identity.region}/${identity.realm}/${identity.name}`
      );
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
            id="character-name"
            name="characterName"
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Character/URL"
            aria-label="Character/URL"
            value={character}
            onChange={(event) => onCharacterChange(event.currentTarget.value)}
            aria-invalid={error !== null}
            aria-describedby={error ? "character-search-error" : undefined}
            disabled={pending}
          />
        </div>
        {showStructuredFields ? (
          <div className="search-field">
            <input
              className="search-input"
              id="character-realm"
              name="characterRealm"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Realm"
              aria-label="Realm"
              value={realm}
              onChange={(event) => {
                setRealm(event.currentTarget.value);
                setName(character);
                setError(null);
              }}
              aria-invalid={error !== null}
              aria-describedby={error ? "character-search-error" : undefined}
              disabled={pending}
            />
          </div>
        ) : null}
        <div className="search-field search-region-field">
          {showStructuredFields ? (
            <select
              className="search-select"
              id="character-region"
              name="characterRegion"
              aria-label="Region"
              value={region}
              onChange={(event) => {
                setRegion(event.currentTarget.value as Region);
                setName(character);
                setError(null);
              }}
              aria-invalid={error !== null}
              aria-describedby={error ? "character-search-error" : undefined}
              disabled={pending}
            >
              {supportedRegions.map((supportedRegion) => (
                <option key={supportedRegion} value={supportedRegion}>
                  {supportedRegion.toUpperCase()}
                </option>
              ))}
            </select>
          ) : null}
          <button
            className="search-button"
            type="submit"
            aria-label="Research applicant"
            title="Research applicant"
            disabled={pending}
          >
            {pending ? "…" : "→"}
          </button>
        </div>
      </div>
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
