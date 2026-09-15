"use client";

import {
  applicantDossierSchema,
  dossierStartResponseSchema,
  dossierResearchStatusSchema,
  safeApiErrorSchema,
  type ApplicantDossier,
  type CharacterKey
} from "@slashwho/contracts";
import { formatCharacterDisplayName } from "@slashwho/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  credentialHeaders,
  readStoredCredentials
} from "../../../../../lib/api-credentials";
import { DossierCharacterList } from "../../../../../components/dossier-character-list";
import {
  DossierCharacterName,
  DossierCharacterProvider
} from "../../../../../components/dossier-character-name";
import { DossierCuttingEdgeList } from "../../../../../components/dossier-cutting-edge-list";
import { DossierLimitations } from "../../../../../components/dossier-limitations";
import { DossierRaidList } from "../../../../../components/dossier-raid-list";
import { DossierRateLimitCountdown } from "../../../../../components/dossier-rate-limit-countdown";
import { DossierResearchState } from "../../../../../components/dossier-research-state";
import { CharacterProfileLinks } from "../../../../../components/profile-links";
import { headerIdentitySlotId } from "../../../../../components/site-header";

type DossierPageClientProps = Readonly<{
  identity: CharacterKey;
  initialDossier: ApplicantDossier | null;
  jobId: string | null;
  /** The demo dossier is read-only, so it offers no way to link characters. */
  canAddCharacters?: boolean;
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
  jobId,
  canAddCharacters = true
}: DossierPageClientProps) {
  const [dossier, setDossier] = useState(initialDossier);
  const [activeJobId, setActiveJobId] = useState(jobId);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [researchFailed, setResearchFailed] = useState(false);
  const [identityHidden, setIdentityHidden] = useState(false);
  const [identitySlot, setIdentitySlot] = useState<HTMLElement | null>(null);
  const identityRef = useRef<HTMLDivElement>(null);
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

  // A manually connected character changes the dossier immediately, so read it
  // back rather than reloading the page and discarding the polls in flight.
  const refreshDossier = useCallback(async () => {
    const response = await fetch(dossierPath, { cache: "no-store" });
    if (!response.ok) return;
    const body: unknown = await response.json().catch(() => null);
    const parsed = applicantDossierSchema.safeParse(body);
    if (!parsed.success) return;
    hasExpandedDossier.current = true;
    setDossier(parsed.data);
    setInitialError(null);
    setError(null);
  }, [dossierPath]);

  useEffect(() => {
    const controller = new AbortController();

    async function readJson(response: Response): Promise<unknown> {
      return response.json().catch(() => null);
    }

    async function readInitialDossier() {
      const response = await fetch(`${dossierPath}?scope=initial`, {
        cache: "no-store",
        signal: controller.signal,
        headers: credentialHeaders(readStoredCredentials())
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
        signal: controller.signal,
        headers: credentialHeaders(readStoredCredentials())
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

    async function startResearch(researchRoot = identity) {
      try {
        const response = await fetch("/api/dossiers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            characterUrl: `https://raider.io/characters/${researchRoot.region}/${researchRoot.realm}/${researchRoot.name}`
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
            if (
              parsed.data.root.region !== identity.region ||
              parsed.data.root.realm !== identity.realm ||
              parsed.data.root.name !== identity.name
            ) {
              await startResearch(parsed.data.root);
              return;
            }
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
    // The read-only demo never has live evidence to catch up on, and its
    // frozen dossier is never re-fetchable, so it must never poll.
    if (!canAddCharacters) return;
    if (dossier?.research.state !== "gathering") return;

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let attempt = 0;

    function schedulePoll() {
      const delay = pollDelaysMs[Math.min(attempt, pollDelaysMs.length - 1)];
      attempt += 1;
      timeout = setTimeout(() => void pollEvidence(), delay);
    }

    async function pollEvidence() {
      try {
        const response = await fetch(dossierPath, {
          cache: "no-store",
          signal: controller.signal
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) {
            schedulePoll();
            return;
          }
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
        schedulePoll();
      } catch (caught) {
        if (caught instanceof Error && caught.name === "AbortError") return;
        if (!stopped) {
          schedulePoll();
        }
      }
    }

    timeout = setTimeout(() => void pollEvidence(), pollDelaysMs[0]);

    return () => {
      stopped = true;
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [canAddCharacters, dossier?.research.state, dossierPath]);

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

  useEffect(() => {
    const target = identityRef.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      setIdentityHidden(!(entry?.isIntersecting ?? true));
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setIdentitySlot(document.getElementById(headerIdentitySlotId));
  }, []);

  // The header owns this slot, so the identity is laid out by the header grid
  // instead of floating over whatever the header happens to hold.
  const identityBadge = (
    <div
      className="dossier-header-identity"
      role="status"
      aria-label="Current character"
    >
      <DossierCharacterName character={identity} />
      <span>
        {identity.region.toUpperCase()} · {identity.realm}
      </span>
    </div>
  );
  return (
    <DossierCharacterProvider characters={dossier?.characters ?? []}>
      <main className="page-shell dossier-page">
        <header className="dossier-heading">
          <div ref={identityRef}>
            <p className="eyebrow">Applicant dossier</p>
            <h1>
              <DossierCharacterName character={identity} />
            </h1>
            <p className="identity-meta">
              {identity.region.toUpperCase()} · {identity.realm}
            </p>
            {dossier?.limitations.map((limitation, index) =>
              limitation.retryAt ? (
                <DossierRateLimitCountdown
                  key={`${limitation.source}-${limitation.code}-${index}`}
                  retryAt={limitation.retryAt}
                  source={limitation.source}
                />
              ) : null
            )}
          </div>
          <CharacterProfileLinks
            character={{ key: identity, displayName: rootDisplayName }}
          />
        </header>
        {identityHidden && identitySlot
          ? createPortal(identityBadge, identitySlot)
          : null}

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
        {notice ? (
          <p className="dossier-notice" role="status">
            {notice}
          </p>
        ) : null}

        {dossier ? (
          <div className="dossier-layout">
            <DossierCharacterList
              canAddCharacters={canAddCharacters}
              characters={dossier.characters}
              onCharacterAdded={(added) => {
                const name = formatCharacterDisplayName(added.key.name);
                setNotice(
                  added.queued
                    ? `${name} has been added and is being researched.`
                    : `${name} has been added to this dossier.`
                );
                void refreshDossier();
              }}
              root={dossier.root}
            />
            <DossierCuttingEdgeList
              cuttingEdges={dossier.cuttingEdges}
              limitations={dossier.limitations}
            />
            <DossierRaidList
              raids={dossier.raids}
              loading={dossier.research.state === "gathering"}
              limitations={dossier.limitations}
            />
            <DossierLimitations limitations={dossier.limitations} />
          </div>
        ) : null}
      </main>
    </DossierCharacterProvider>
  );
}
