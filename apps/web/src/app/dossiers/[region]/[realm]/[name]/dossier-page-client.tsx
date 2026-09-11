"use client";

import {
  applicantDossierSchema,
  jobStatusResponseSchema,
  safeApiErrorSchema,
  type ApplicantDossier,
  type CharacterKey
} from "@slashwho/contracts";
import { useEffect, useMemo, useState } from "react";

import { DossierCharacterList } from "../../../../../components/dossier-character-list";
import { DossierLimitations } from "../../../../../components/dossier-limitations";
import { DossierRaidList } from "../../../../../components/dossier-raid-list";

type DossierPageClientProps = Readonly<{
  identity: CharacterKey;
  initialDossier: ApplicantDossier | null;
  jobId: string | null;
}>;

const activeJobStates = new Set(["queued", "running", "retrying"]);
const pollDelaysMs = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

function apiError(response: Response, body: unknown): string {
  if (response.status === 404) return "This applicant dossier was not found.";
  if (response.status === 429) return "Too many dossier requests. Please try again shortly.";
  const parsed = safeApiErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.error.message : "The dossier could not be loaded.";
}

export function DossierPageClient({
  identity,
  initialDossier,
  jobId
}: DossierPageClientProps) {
  const [dossier, setDossier] = useState(initialDossier);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState(
    initialDossier ? null : jobId ? "Researching applicant dossier…" : "Loading applicant dossier…"
  );
  const dossierPath = useMemo(
    () => `/api/dossiers/${identity.region}/${identity.realm}/${identity.name}`,
    [identity]
  );

  useEffect(() => {
    if (dossier) return;

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let attempt = 0;

    async function readJson(response: Response): Promise<unknown> {
      return response.json().catch(() => null);
    }

    function schedulePoll() {
      const delay = pollDelaysMs[Math.min(attempt, pollDelaysMs.length - 1)];
      attempt += 1;
      timeout = setTimeout(() => void pollJob(), delay);
    }

    async function readDossier() {
      const response = await fetch(dossierPath, {
        cache: "no-store",
        signal: controller.signal
      });
      const body = await readJson(response);
      if (!response.ok) {
        if (response.status === 409 && jobId) {
          setStatus("Researching applicant dossier…");
          schedulePoll();
          return;
        }
        setError(apiError(response, body));
        setStatus(null);
        return;
      }
      const parsed = applicantDossierSchema.safeParse(body);
      if (!parsed.success) {
        setError("The dossier returned an unexpected response.");
      } else {
        setDossier(parsed.data);
      }
      setStatus(null);
    }

    async function pollJob() {
      if (!jobId) return;
      try {
        const response = await fetch(`/api/v1/searches/${jobId}`, {
          cache: "no-store",
          signal: controller.signal
        });
        const body = await readJson(response);
        if (!response.ok) {
          setError(apiError(response, body));
          setStatus(null);
          return;
        }
        const parsed = jobStatusResponseSchema.safeParse(body);
        if (!parsed.success) {
          setError("The applicant research returned an unexpected response.");
          setStatus(null);
          return;
        }
        if (parsed.data.status === "complete") {
          await readDossier();
          return;
        }
        if (parsed.data.status === "failed") {
          setError(parsed.data.error?.message ?? "The applicant research could not be completed.");
          setStatus(null);
          return;
        }
        if (activeJobStates.has(parsed.data.status)) schedulePoll();
      } catch (caught) {
        if (stopped || (caught instanceof Error && caught.name === "AbortError")) return;
        setError("The applicant research status could not be loaded.");
        setStatus(null);
      }
    }

    if (jobId) void pollJob();
    else void readDossier().catch((caught) => {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setError("The dossier could not be loaded. Please check your connection.");
      setStatus(null);
    });

    return () => {
      stopped = true;
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [dossier, dossierPath, jobId]);

  return (
    <main className="page-shell dossier-page">
      <header className="dossier-heading">
        <p className="eyebrow">Applicant dossier</p>
        <h1>{identity.name}</h1>
        <p className="identity-meta">
          {identity.region.toUpperCase()} · {identity.realm}
        </p>
      </header>

      {status ? <p className="dossier-status" aria-live="polite">{status}</p> : null}
      {error ? <p className="view-error" role="alert">{error}</p> : null}

      {dossier ? (
        <div className="dossier-layout">
          <DossierCharacterList characters={dossier.characters} />
          <DossierRaidList raids={dossier.raids} />
          <DossierLimitations limitations={dossier.limitations} />
        </div>
      ) : null}
    </main>
  );
}
