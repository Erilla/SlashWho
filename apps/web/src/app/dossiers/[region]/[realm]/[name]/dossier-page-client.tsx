"use client";

import {
  applicantDossierSchema,
  dossierStartResponseSchema,
  dossierResearchStatusSchema,
  safeApiErrorSchema,
  type ApplicantDossier,
  type CharacterKey
} from "@slashwho/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { DossierCharacterList } from "../../../../../components/dossier-character-list";
import {
  DossierCharacterName,
  DossierCharacterProvider
} from "../../../../../components/dossier-character-name";
import { DossierCuttingEdgeList } from "../../../../../components/dossier-cutting-edge-list";
import { DossierLimitations } from "../../../../../components/dossier-limitations";
import { DossierRaidList } from "../../../../../components/dossier-raid-list";
import { DossierResearchState } from "../../../../../components/dossier-research-state";
import { SearchForm } from "../../../../../components/search-form";
import { CharacterProfileLinks } from "../../../../../components/profile-links";

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
  const [activeJobId, setActiveJobId] = useState(jobId);
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
      const response = await fetch(`${dossierPath}?scope=initial`, {
        cache: "no-store",
        signal: controller.signal
      });
      const body = await readJson(response);
      if (controller.signal.aborted || hasExpandedDossier.current) return;
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

    if (!initialDossier && activeJobId)
      void readInitialDossier().catch((caught) => {
        if (caught instanceof Error && caught.name === "AbortError") return;
        if (controller.signal.aborted || hasExpandedDossier.current) return;
        setInitialError(
          "The dossier could not be loaded. Please check your connection."
        );
      });

    return () => controller.abort();
  }, [activeJobId, dossierPath, initialDossier]);

  useEffect(() => {
    if (activeJobId || initialDossier) return;

    const controller = new AbortController();

    async function readJson(response: Response): Promise<unknown> {
      return response.json().catch(() => null);
    }

    async function readCompletedDossier() {
      const response = await fetch(dossierPath, {
        cache: "no-store",
        signal: controller.signal
      });
      const body = await readJson(response);
      if (controller.signal.aborted) return;
      if (!response.ok) {
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

    async function startResearch() {
      try {
        const response = await fetch("/api/dossiers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            characterUrl: `https://raider.io/characters/${identity.region}/${identity.realm}/${identity.name}`
          }),
          cache: "no-store",
          signal: controller.signal
        });
        const body = await readJson(response);
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setError(apiError(response, body));
          setStatus(null);
          return;
        }
        const parsed = dossierStartResponseSchema.safeParse(body);
        if (!parsed.success) {
          setError("The applicant research returned an unexpected response.");
          setStatus(null);
          return;
        }
        if (parsed.data.kind === "job") {
          setActiveJobId(parsed.data.jobId);
          setStatus("Researching applicant dossier…");
          return;
        }
        await readCompletedDossier();
      } catch (caught) {
        if (caught instanceof Error && caught.name === "AbortError") return;
        if (controller.signal.aborted) return;
        setError("The applicant research could not be started.");
        setStatus(null);
      }
    }

    async function readCurrentOrStartResearch() {
      try {
        const response = await fetch(dossierPath, {
          cache: "no-store",
          signal: controller.signal
        });
        const body = await readJson(response);
        if (controller.signal.aborted) return;
        if (response.ok) {
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
          return;
        }
        const parsedError = safeApiErrorSchema.safeParse(body);
        if (
          response.status !== 409 ||
          !parsedError.success ||
          parsedError.data.error.code !== "discovery_not_ready"
        ) {
          setError(apiError(response, body));
          setStatus(null);
          return;
        }
        await startResearch();
      } catch (caught) {
        if (caught instanceof Error && caught.name === "AbortError") return;
        if (controller.signal.aborted) return;
        setError(
          "The dossier could not be loaded. Please check your connection."
        );
        setStatus(null);
      }
    }

    void readCurrentOrStartResearch();

    return () => controller.abort();
  }, [activeJobId, dossierPath, identity, initialDossier]);

  useEffect(() => {
    if (!activeJobId) return;

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
        const response = await fetch(`/api/dossiers/jobs/${activeJobId}`, {
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
  }, [activeJobId, dossierPath]);

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
  const rootDisplayName =
    dossier?.characters.find(
      (character) =>
        character.key.region === identity.region &&
        character.key.realm.toLowerCase() === identity.realm.toLowerCase() &&
        character.key.name.toLowerCase() === identity.name.toLowerCase()
    )?.displayName ?? identity.name;
  const visibleResearch =
    research && research.state === "initial" && researchFailed
      ? {
          ...research,
          message:
            "Linked-character research failed; this evidence covers only the submitted character."
        }
      : research;

  return (
    <DossierCharacterProvider characters={dossier?.characters ?? []}>
      <main className="page-shell dossier-page">
        <div className="dossier-search">
          <SearchForm />
        </div>
        <header className="dossier-heading">
          <div>
            <p className="eyebrow">Applicant dossier</p>
            <h1>
              <DossierCharacterName character={identity} />
            </h1>
            <p className="identity-meta">
              {identity.region.toUpperCase()} · {identity.realm}
            </p>
          </div>
          <CharacterProfileLinks
            character={{ key: identity, displayName: rootDisplayName }}
          />
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
            <DossierCharacterList
              characters={dossier.characters}
              root={dossier.root}
            />
            <DossierCuttingEdgeList
              cuttingEdges={dossier.cuttingEdges}
              limitations={dossier.limitations}
            />
            <DossierRaidList raids={dossier.raids} />
            <DossierLimitations limitations={dossier.limitations} />
          </div>
        ) : null}
      </main>
    </DossierCharacterProvider>
  );
}
