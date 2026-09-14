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

const invalidUrlMessage = "Enter a Raider.IO or Warcraft Logs character URL.";
const invalidStructuredUrlMessage =
  "Enter a valid character URL, or character name, realm, and region.";
const defaultRegion: Region = "eu";

type SearchMode = "url" | "structured";

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
  const [mode, setMode] = useState<SearchMode>("url");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [realm, setRealm] = useState("");
  const [region, setRegion] = useState<Region>(defaultRegion);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function toStructuredCharacterUrl(): string {
    return `https://www.warcraftlogs.com/character/${region}/${encodeURIComponent(realm)}/${encodeURIComponent(name)}`;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    let identity: ReturnType<typeof parseApplicantCharacterUrl>;
    let characterUrl: string;
    try {
      if (mode === "url") {
        characterUrl = url.trim();
        identity = parseApplicantCharacterUrl(characterUrl);
      } else {
        characterUrl = toStructuredCharacterUrl();
        identity = parseApplicantCharacterUrl(characterUrl);
      }
    } catch {
      setError(
        mode === "url" ? invalidUrlMessage : invalidStructuredUrlMessage
      );
      return;
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
        return;
      }
      router.push(
        `/dossiers/${identity.region}/${identity.realm}/${identity.name}`
      );
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
      <fieldset className="search-mode">
        <legend className="visually-hidden">Search mode</legend>
        <label className="search-mode-option">
          <input
            type="radio"
            name="search-mode"
            value="url"
            checked={mode === "url"}
            onChange={() => {
              setMode("url");
              setError(null);
            }}
            disabled={pending}
          />
          Character URL
        </label>
        <label className="search-mode-option">
          <input
            type="radio"
            name="search-mode"
            value="structured"
            checked={mode === "structured"}
            onChange={() => {
              setMode("structured");
              setError(null);
            }}
            disabled={pending}
          />
          Character name + realm
        </label>
      </fieldset>
      {mode === "url" ? (
        <>
          <label className="visually-hidden" htmlFor="character-url">
            Applicant URL
          </label>
          <div className="search-control">
            <input
              className="search-input"
              id="character-url"
              name="characterUrl"
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Raider.IO or Warcraft Logs character URL"
              value={url}
              onChange={(event) => setUrl(event.currentTarget.value)}
              aria-invalid={error !== null}
              aria-describedby={error ? "character-search-error" : undefined}
              disabled={pending}
            />
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
        </>
      ) : (
        <div className="search-structured-grid">
          <div className="search-field">
            <label htmlFor="character-name">Character name</label>
            <input
              className="search-input"
              id="character-name"
              name="characterName"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Ryii"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              aria-invalid={error !== null}
              aria-describedby={error ? "character-search-error" : undefined}
              disabled={pending}
            />
          </div>
          <div className="search-field">
            <label htmlFor="character-realm">Realm</label>
            <input
              className="search-input"
              id="character-realm"
              name="characterRealm"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="silvermoon"
              value={realm}
              onChange={(event) => setRealm(event.currentTarget.value)}
              aria-invalid={error !== null}
              aria-describedby={error ? "character-search-error" : undefined}
              disabled={pending}
            />
          </div>
          <div className="search-field search-region-field">
            <label htmlFor="character-region">Region</label>
            <select
              className="search-select"
              id="character-region"
              name="characterRegion"
              value={region}
              onChange={(event) =>
                setRegion(event.currentTarget.value as Region)
              }
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
      )}
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
