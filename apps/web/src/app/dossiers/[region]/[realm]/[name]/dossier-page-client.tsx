"use client";

import {
  applicantDossierSchema,
  dossierResearchStatusSchema,
  safeApiErrorSchema,
  type ApplicantDossier,
  type CharacterKey
} from "@slashwho/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { DossierCharacterList } from "../../../../../components/dossier-character-list";
import { DossierCuttingEdgeList } from "../../../../../components/dossier-cutting-edge-list";
import { DossierLimitations } from "../../../../../components/dossier-limitations";
import { DossierRaidList } from "../../../../../components/dossier-raid-list";
import { DossierResearchState } from "../../../../../components/dossier-research-state";

type DossierPageClientProps = Readonly<{
  identity: CharacterKey;
  initialDossier: ApplicantDossier | null;
  jobId: string | null;
}>;

const activeJobStates = new Set(["queued", "running", "retrying"]);
const pollDelaysMs = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

function apiError(response: Response, body: unknown): string {
  if (response.status === 404) return "This applicant dossier was not found.";
  if (response.status === 429)
    return "Too many dossier requests. Please try again shortly.";
  const parsed = safeApiErrorSchema.safeParse(body);
  return parsed.success
    ? parsed.data.error.message
    : "The dossier could not be loaded.";
}

export function DossierPageClient({
  identity,
  initialDossier,
  jobId
}: DossierPageClientProps) {
  const [dossier, setDossier] = useState(initialDossier);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [researchFailed, setResearchFailed] = useState(false);
  const [status, setStatus] = useState(
    initialDossier
      ? null
      : jobId
        ? "Researching applicant dossier…"
        : "Loading applicant dossier…"
  );
  const hasExpandedDossier = useRef(false);
  const dossierPath = useMemo(
    () => `/api/dossiers/${identity.region}/${identity.realm}/${identity.name}`,
    [identity]
  );

  useEffect(() => {
    const controller = new AbortController();

    async function readJson(response: Response): Promise<unknown> {
      return response.json().catch(() => null);
    }

    async function readInitialDossier() {
      let response = await fetch(
        jobId ? `${dossierPath}?scope=initial` : dossierPath,
        {
          cache: "no-store",
          signal: controller.signal
        }
      );
      if (!jobId && response.status === 409) {
        response = await fetch(`${dossierPath}?scope=initial`, {
          cache: "no-store",
          signal: controller.signal
        });
      }
      const body = await readJson(response);
      if (controller.signal.aborted || hasExpandedDossier.current) return;
      if (!jobId) setStatus(null);
      if (!response.ok) {
        setInitialError(apiError(response, body));
        return;
      }
      const parsed = applicantDossierSchema.safeParse(body);
      if (!parsed.success) {
        setInitialError("The dossier returned an unexpected response.");
      } else {
        setDossier(parsed.data);
      }
    }

    if (!initialDossier)
      void readInitialDossier().catch((caught) => {
        if (caught instanceof Error && caught.name === "AbortError") return;
        if (controller.signal.aborted || hasExpandedDossier.current) return;
        setInitialError(
          "The dossier could not be loaded. Please check your connection."
        );
        if (!jobId) setStatus(null);
      });

    return () => controller.abort();
  }, [dossierPath, initialDossier, jobId]);

  useEffect(() => {
    if (!jobId) return;

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

    async function readExpandedDossier() {
      const response = await fetch(dossierPath, {
        cache: "no-store",
        signal: controller.signal
      });
      const body = await readJson(response);
      if (!response.ok) {
        if (response.status === 409) {
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
        hasExpandedDossier.current = true;
        setDossier(parsed.data);
        setInitialError(null);
        setError(null);
      }
      setStatus(null);
    }

    async function pollJob() {
      try {
        const response = await fetch(`/api/dossiers/jobs/${jobId}`, {
          cache: "no-store",
          signal: controller.signal
        });
        const body = await readJson(response);
        if (!response.ok) {
          setError(apiError(response, body));
          setStatus(null);
          return;
        }
        const parsed = dossierResearchStatusSchema.safeParse(body);
        if (!parsed.success) {
          setError("The applicant research returned an unexpected response.");
          setStatus(null);
          return;
        }
        if (parsed.data.status === "complete") {
          await readExpandedDossier();
          return;
        }
        if (parsed.data.status === "failed") {
          setResearchFailed(true);
          setError(
            parsed.data.error?.message ??
              "The applicant research could not be completed."
          );
          setStatus(null);
          return;
        }
        if (activeJobStates.has(parsed.data.status)) schedulePoll();
      } catch (caught) {
        if (caught instanceof Error && caught.name === "AbortError") return;
        if (stopped) return;
        setError("The applicant research status could not be loaded.");
        setStatus(null);
      }
    }

    void pollJob();

    return () => {
      stopped = true;
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [dossierPath, jobId]);

  useEffect(() => {
    if (dossier?.research.state !== "gathering") return;

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let attempt = 0;

    async function pollEvidence() {
      try {
        const response = await fetch(dossierPath, {
          cache: "no-store",
          signal: controller.signal
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          setError(apiError(response, body));
          return;
        }
        const parsed = applicantDossierSchema.safeParse(body);
        if (!parsed.success) {
          setError("The dossier returned an unexpected response.");
          return;
        }
        setDossier(parsed.data);
        setInitialError(null);
        setError(null);
        if (parsed.data.research.state !== "gathering") return;
        const delay = pollDelaysMs[Math.min(attempt, pollDelaysMs.length - 1)];
        attempt += 1;
        timeout = setTimeout(() => void pollEvidence(), delay);
      } catch (caught) {
        if (caught instanceof Error && caught.name === "AbortError") return;
        if (!stopped) {
          setError("The applicant evidence status could not be loaded.");
        }
      }
    }

    timeout = setTimeout(() => void pollEvidence(), pollDelaysMs[0]);

    return () => {
      stopped = true;
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [dossier?.research.state, dossierPath]);

  const visibleError = error ?? initialError;
  const research = dossier?.research;
  const visibleResearch =
    research && research.state === "initial" && researchFailed
      ? {
          ...research,
          message:
            "Linked-character research failed; this evidence covers only the submitted character."
        }
      : research;

  return (
    <main className="page-shell dossier-page">
      <header className="dossier-heading">
        <p className="eyebrow">Applicant dossier</p>
        <h1>{identity.name}</h1>
        <p className="identity-meta">
          {identity.region.toUpperCase()} · {identity.realm}
        </p>
      </header>

      {visibleResearch ? (
        <DossierResearchState research={visibleResearch} />
      ) : null}
      {status && !dossier ? (
        <p className="dossier-status" role="status">
          <svg
            aria-hidden="true"
            className="dossier-loading-spinner"
            viewBox="0 0 24 24"
          >
            <circle cx="12" cy="12" r="8" />
          </svg>
          <span>{status}</span>
        </p>
      ) : null}
      {visibleError ? (
        <p className="view-error" role="alert">
          {visibleError}
        </p>
      ) : null}

      {dossier ? (
        <div className="dossier-layout">
          <DossierCharacterList characters={dossier.characters} />
          <DossierCuttingEdgeList
            cuttingEdges={dossier.cuttingEdges}
            limitations={dossier.limitations}
          />
          <DossierRaidList raids={dossier.raids} />
          <DossierLimitations limitations={dossier.limitations} />
        </div>
      ) : null}
    </main>
  );
}
