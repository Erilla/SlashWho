"use client";

import {
  createSearchResponseSchema,
  safeApiErrorSchema
} from "@slashwho/contracts";
import { parseApplicantCharacterUrl } from "@slashwho/domain";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

const invalidUrlMessage = "Enter a Raider.IO or Warcraft Logs character URL.";

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
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    let identity: ReturnType<typeof parseApplicantCharacterUrl>;
    try {
      identity = parseApplicantCharacterUrl(value);
    } catch {
      setError(invalidUrlMessage);
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/dossiers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterUrl: value })
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(errorMessage(response, body));
        return;
      }
      const parsed = createSearchResponseSchema.safeParse(body);
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
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          aria-invalid={error !== null}
          aria-describedby={error ? "character-url-error" : undefined}
          disabled={pending}
        />
        <button className="search-button" type="submit" disabled={pending}>
          {pending ? "Researching…" : "Research applicant"}
        </button>
      </div>
      <p
        className="form-error"
        id="character-url-error"
        role={error ? "alert" : undefined}
        aria-live="polite"
      >
        {error ?? ""}
      </p>
    </form>
  );
}
