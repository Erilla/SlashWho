"use client";

import {
  applicantDossierSchema,
  dossierStartResponseSchema,
  dossierResearchStatusSchema,
  safeApiErrorSchema,
  type ApplicantDossier,
  type CharacterKey,
  type DossierTierSearchResponse
} from "@slashwho/contracts";
import { formatCharacterDisplayName } from "@slashwho/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { credentialHeadersForRequest } from "../../../../../lib/api-credentials";
import { evidenceFilter } from "../../../../../lib/character-visibility";
import { dossierTitle } from "../../../../../lib/dossier-title";
import {
  type PollReadResult,
  retryAfterMilliseconds,
  useAuthoritativePoll
} from "../../../../../lib/use-authoritative-poll";
import { useCharacterVisibility } from "../../../../../lib/use-character-visibility";
import { DossierCharacterList } from "../../../../../components/dossier-character-list";
import {
  DossierCharacterName,
  DossierCharacterProvider
} from "../../../../../components/dossier-character-name";
import { DossierCuttingEdgeList } from "../../../../../components/dossier-cutting-edge-list";
import { DossierLimitations } from "../../../../../components/dossier-limitations";
import { DossierRaidList } from "../../../../../components/dossier-raid-list";
import { DossierRateLimitCountdown } from "../../../../../components/dossier-rate-limit-countdown";
import { DossierRefreshControl } from "../../../../../components/dossier-refresh-control";
import { DossierResearchState } from "../../../../../components/dossier-research-state";
import { DossierSectionNavigation } from "../../../../../components/dossier-section-navigation";
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

function hasLiveEvidence(value: ApplicantDossier | null): boolean {
  return (
    value?.characters.some(
      (character) =>
        !character.excluded &&
        (character.evidenceState === "waiting" ||
          character.evidenceState === "scanning" ||
          character.evidenceState === "partial")
    ) ?? false
  );
}

/**
 * Whether any tier's search is in flight (#449). A search may run for a
 * character beyond the list's cap, whose own evidence state is never shown,
 * so polling follows the searches as well as the listed characters.
 */
function hasLiveTierSearch(value: ApplicantDossier | null): boolean {
  return (
    value?.raids.some(
      (raid) =>
        raid.tierSearch?.state === "queued" ||
        raid.tierSearch?.state === "running"
    ) ?? false
  );
}

function dossierCharacterKey(character: CharacterKey): string {
  return `${character.region}:${character.realm}:${character.name}`;
}

function evidenceStatesByCharacter(value: ApplicantDossier | null) {
  return new Map(
    (value?.characters ?? [])
      .filter((character) => !character.excluded)
      .map((character) => [
        dossierCharacterKey(character.key),
        { name: character.displayName, state: character.evidenceState }
      ])
  );
}

function evidenceAnnouncement(
  previous: ApplicantDossier | null,
  next: ApplicantDossier | null
): string | null {
  const before = evidenceStatesByCharacter(previous);
  const announcements: string[] = [];
  for (const [key, current] of evidenceStatesByCharacter(next)) {
    if (
      (current.state !== "partial" && current.state !== "complete") ||
      before.get(key)?.state === current.state
    )
      continue;
    announcements.push(
      `${current.name} evidence collection is ${current.state}.`
    );
  }
  return announcements.length === 0 ? null : announcements.join(" ");
}

function evidenceStatesChanged(
  previous: ApplicantDossier | null,
  next: ApplicantDossier | null
): boolean {
  const before = evidenceStatesByCharacter(previous);
  const after = evidenceStatesByCharacter(next);
  if (before.size !== after.size) return true;
  for (const [key, current] of after) {
    if (before.get(key)?.state !== current.state) return true;
  }
  return false;
}

function apiError(response: Response, body: unknown): string {
  const parsed = safeApiErrorSchema.safeParse(body);
  if (parsed.success && parsed.data.error.code === "character_not_found") {
    return parsed.data.error.message;
  }
  if (response.status === 404) return "This applicant dossier was not found.";
  if (response.status === 429)
    return "Too many dossier requests. Please try again shortly.";
  return parsed.success
    ? parsed.data.error.message
    : "The dossier could not be loaded.";
}

export function DossierPageClient(props: DossierPageClientProps) {
  const { identity } = props;
  return (
    <DossierPageState
      key={`${identity.region}/${identity.realm}/${identity.name}`}
      {...props}
    />
  );
}

function DossierPageState({
  identity,
  initialDossier,
  jobId,
  canAddCharacters = true
}: DossierPageClientProps) {
  const [dossier, setDossier] = useState(initialDossier);
  const characters = dossier?.characters;
  const visibility = useCharacterVisibility(identity, characters ?? []);
  const filter = useMemo(
    () => evidenceFilter(characters ?? [], visibility.hidden),
    [characters, visibility.hidden]
  );
  const [activeJobId, setActiveJobId] = useState(jobId);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pollUnavailable, setPollUnavailable] = useState(false);
  const [pollStopped, setPollStopped] = useState(false);
  const terminalPollError = useRef(
    "The dossier returned an unexpected response."
  );
  const previousDossier = useRef(initialDossier);
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
  const requestSequence = useRef(0);
  const appliedSequence = useRef(0);

  useEffect(() => {
    const nextAnnouncement = evidenceAnnouncement(
      previousDossier.current,
      dossier
    );
    if (nextAnnouncement) setAnnouncement(nextAnnouncement);
    else if (evidenceStatesChanged(previousDossier.current, dossier))
      setAnnouncement("");
    previousDossier.current = dossier;
  }, [dossier]);
  const dossierPath = useMemo(
    () => `/api/dossiers/${identity.region}/${identity.realm}/${identity.name}`,
    [identity]
  );

  // A manually connected character changes the dossier immediately, so read it
  // back rather than reloading the page and discarding the polls in flight.
  const refreshDossier = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const response = await fetch(dossierPath, {
      cache: "no-store",
      headers: await credentialHeadersForRequest()
    });
    if (!response.ok) return;
    const body: unknown = await response.json().catch(() => null);
    if (sequence < appliedSequence.current) return;
    const parsed = applicantDossierSchema.safeParse(body);
    if (!parsed.success) return;
    appliedSequence.current = sequence;
    hasExpandedDossier.current = true;
    setDossier(parsed.data);
    setInitialError(null);
    setError(null);
    setPollUnavailable(false);
    setPollStopped(false);
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
        headers: await credentialHeadersForRequest()
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

    // A character new to discovery may already be claimed in another root's
    // snapshot, and a stale root still has its previous one; either is more
    // than the root-only view, so read it while the job runs. Discovery not
    // being ready yet is the expected answer otherwise, and leaves the
    // initial view in place.
    async function readKnownDossier() {
      const sequence = ++requestSequence.current;
      const response = await fetch(dossierPath, {
        cache: "no-store",
        signal: controller.signal,
        headers: await credentialHeadersForRequest()
      });
      if (!response.ok) return;
      const body = await readJson(response);
      if (controller.signal.aborted || sequence < appliedSequence.current)
        return;
      const parsed = applicantDossierSchema.safeParse(body);
      if (!parsed.success) return;
      appliedSequence.current = sequence;
      hasExpandedDossier.current = true;
      setDossier(parsed.data);
      setInitialError(null);
    }

    if (!initialDossier && activeJobId) {
      void readInitialDossier().catch((caught) => {
        if (caught instanceof Error && caught.name === "AbortError") return;
        if (controller.signal.aborted || hasExpandedDossier.current) return;
        setInitialError(
          "The dossier could not be loaded. Please check your connection."
        );
      });
      // A direct visit reached its job through a full read already.
      if (!hasExpandedDossier.current)
        void readKnownDossier().catch(() => undefined);
    }

    return () => controller.abort();
  }, [activeJobId, dossierPath, initialDossier]);

  useEffect(() => {
    if (activeJobId || initialDossier) return;

    const controller = new AbortController();

    async function readJson(response: Response): Promise<unknown> {
      return response.json().catch(() => null);
    }

    async function readCompletedDossier() {
      const sequence = ++requestSequence.current;
      const response = await fetch(dossierPath, {
        cache: "no-store",
        signal: controller.signal,
        headers: await credentialHeadersForRequest()
      });
      const body = await readJson(response);
      if (controller.signal.aborted || sequence < appliedSequence.current)
        return;
      if (!response.ok) {
        setError(apiError(response, body));
        setStatus(null);
        return;
      }
      const parsed = applicantDossierSchema.safeParse(body);
      if (!parsed.success) {
        setError("The dossier returned an unexpected response.");
      } else {
        appliedSequence.current = sequence;
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
          setResearchFailed(true);
          setError(apiError(response, body));
          setStatus(null);
          return;
        }
        const parsed = dossierStartResponseSchema.safeParse(body);
        if (!parsed.success) {
          setResearchFailed(true);
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
        setResearchFailed(true);
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
            const rootOnly = parsed.data.characters.some(
              (character) => character.source === "submitted"
            );
            hasExpandedDossier.current = !rootOnly;
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
            // A provisional list is another root's account shown under this
            // character, so its own discovery still has to run.
            if (rootOnly || parsed.data.research.state === "provisional") {
              await startResearch();
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
      const sequence = ++requestSequence.current;
      const response = await fetch(dossierPath, {
        cache: "no-store",
        signal: controller.signal,
        headers: await credentialHeadersForRequest()
      });
      const body = await readJson(response);
      if (controller.signal.aborted || sequence < appliedSequence.current)
        return;
      if (!response.ok) {
        if (response.status === 409) {
          setStatus("Researching applicant dossier…");
          schedulePoll();
          return;
        }
        appliedSequence.current = sequence;
        setError(apiError(response, body));
        setStatus(null);
        return;
      }
      const parsed = applicantDossierSchema.safeParse(body);
      appliedSequence.current = sequence;
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
        if (controller.signal.aborted) return;
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

  const readDossierPoll = useCallback(
    async (
      signal: AbortSignal
    ): Promise<
      PollReadResult<{ dossier: ApplicantDossier; sequence: number }>
    > => {
      const sequence = ++requestSequence.current;
      let response: Response;
      try {
        response = await fetch(dossierPath, {
          cache: "no-store",
          signal,
          headers: await credentialHeadersForRequest()
        });
      } catch (caught) {
        if (!signal.aborted && sequence >= appliedSequence.current)
          setPollUnavailable(true);
        throw caught;
      }
      if (signal.aborted || sequence < appliedSequence.current)
        return { kind: "retry" };
      if (!response.ok) {
        setPollUnavailable(true);
        if (response.status === 429) {
          return {
            kind: "retry",
            retryAfterMs: retryAfterMilliseconds(response)
          };
        }
        if (response.status >= 500) return { kind: "retry" };
        const body: unknown = await response.json().catch(() => null);
        if (signal.aborted || sequence < appliedSequence.current)
          return { kind: "retry" };
        terminalPollError.current = apiError(response, body);
        appliedSequence.current = sequence;
        return { kind: "terminal", response };
      }
      const body: unknown = await response.json().catch(() => null);
      if (signal.aborted || sequence < appliedSequence.current)
        return { kind: "retry" };
      const parsed = applicantDossierSchema.safeParse(body);
      if (!parsed.success) {
        terminalPollError.current =
          "The dossier returned an unexpected response.";
        appliedSequence.current = sequence;
      }
      return parsed.success
        ? { kind: "snapshot", value: { dossier: parsed.data, sequence } }
        : { kind: "terminal", response };
    },
    [dossierPath]
  );

  const applyFreshDossier = useCallback(
    (snapshot: { dossier: ApplicantDossier; sequence: number }) => {
      if (snapshot.sequence < appliedSequence.current) return;
      appliedSequence.current = snapshot.sequence;
      hasExpandedDossier.current = true;
      setDossier(snapshot.dossier);
      setInitialError(null);
      setError(null);
      setPollUnavailable(false);
    },
    []
  );

  const applyDossierError = useCallback(() => {
    setError(terminalPollError.current);
    setPollUnavailable(true);
    setPollStopped(true);
  }, []);

  useAuthoritativePoll({
    active:
      canAddCharacters &&
      !pollStopped &&
      (hasLiveEvidence(dossier) || hasLiveTierSearch(dossier)),
    read: readDossierPoll,
    onSnapshot: applyFreshDossier,
    onTerminalError: applyDossierError
  });

  const visibleError = error ?? initialError;
  const research = dossier?.research;
  const rootOnly =
    dossier?.characters.some((character) => character.source === "submitted") ??
    false;
  const rootDisplayName =
    dossier?.characters.find(
      (character) =>
        character.key.region === identity.region &&
        character.key.realm.toLowerCase() === identity.realm.toLowerCase() &&
        character.key.name.toLowerCase() === identity.name.toLowerCase()
    )?.displayName ?? identity.name;
  const visibleResearch =
    research && rootOnly && researchFailed
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

  // generateMetadata titles the tab from the route alone, because the guild is
  // only known once the dossier lands.
  const rootGuild = dossier?.characters.find(
    (character) =>
      character.key.region === identity.region &&
      character.key.realm.toLowerCase() === identity.realm.toLowerCase() &&
      character.key.name.toLowerCase() === identity.name.toLowerCase()
  )?.guild;
  // The layout's "%s · Who" template applies to metadata, not to an assigned
  // title, so this carries the suffix itself.
  const guildTitle = rootGuild
    ? `${dossierTitle(identity, rootGuild)} · Who`
    : null;
  useEffect(() => {
    if (!guildTitle) return;
    // The route's own metadata commits during hydration and can land after this
    // effect, and rendering a <title> here loses to it outright: the head keeps
    // both and the document takes the first. Reassert instead of racing, so the
    // guild survives whenever that commit happens.
    const apply = () => {
      if (document.title !== guildTitle) document.title = guildTitle;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, {
      subtree: true,
      childList: true,
      characterData: true
    });
    return () => observer.disconnect();
  }, [guildTitle]);

  // The header owns this slot, so the identity is laid out by the header grid
  // instead of floating over whatever the header happens to hold.
  const identityBadge = (
    <div
      className="dossier-header-identity"
      role="status"
      aria-label="Current character"
    >
      <span className="dossier-character-name-line">
        <DossierCharacterName character={identity} showGuild />
      </span>
      <span>
        {identity.region.toUpperCase()} · {identity.realm}
      </span>
    </div>
  );
  return (
    <DossierCharacterProvider
      characters={dossier?.characters ?? []}
      current={identity}
    >
      <main className="page-shell dossier-page">
        <p
          className="visually-hidden"
          role="status"
          aria-live="polite"
          aria-label={announcement || "Evidence collection updates"}
        >
          {announcement}
        </p>
        <header className="dossier-heading">
          <div ref={identityRef}>
            <p className="eyebrow">Applicant dossier</p>
            <h1>
              <span className="dossier-character-name-line">
                <DossierCharacterName character={identity} showGuild />
              </span>
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
          <div className="dossier-heading-actions">
            <CharacterProfileLinks
              character={{ key: identity, displayName: rootDisplayName }}
            />
            {canAddCharacters ? (
              <DossierRefreshControl
                busy={hasLiveEvidence(dossier) && !pollUnavailable}
                lastCollectedAt={dossier?.lastCollectedAt ?? null}
                onRefresh={async () => {
                  setAnnouncement("");
                  const response = await fetch(
                    `/api/dossiers/${identity.region}/${identity.realm}/${encodeURIComponent(identity.name)}/refresh`,
                    { method: "POST" }
                  );
                  if (!response.ok) throw new Error("refresh_failed");
                  const result = (await response.json()) as {
                    mode: "full" | "light";
                  };
                  await refreshDossier();
                  return result;
                }}
              />
            ) : null}
          </div>
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
          <div className="dossier-navigation-layout">
            <DossierSectionNavigation
              raids={dossier.raids}
              hasLimitations={dossier.limitations.length > 0}
            />
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
                onCharactersChanged={(change) => {
                  const name = formatCharacterDisplayName(change.displayName);
                  setNotice(
                    change.kind === "removed"
                      ? `${name} has been removed from this dossier.`
                      : change.kind === "excluded"
                        ? `${name} is excluded from this dossier.`
                        : change.kind === "alias_added"
                          ? `Historic alias linked to ${name}. Evidence is being re-collected.`
                          : change.kind === "alias_removed"
                            ? `Historic alias removed from ${name}. Evidence is being re-collected.`
                            : `${name} is included in this dossier again.`
                  );
                  void refreshDossier();
                }}
                root={dossier.root}
                visibility={visibility}
              />
              <DossierCuttingEdgeList
                cuttingEdges={dossier.cuttingEdges}
                limitations={dossier.limitations}
              />
              <DossierRaidList
                filter={filter}
                onShowAllCharacters={visibility.showAll}
                raids={dossier.raids}
                loading={hasLiveEvidence(dossier)}
                limitations={dossier.limitations}
                {...(canAddCharacters
                  ? {
                      onSearchTier: async (raidId: string) => {
                        const response = await fetch(
                          `/api/dossiers/${identity.region}/${identity.realm}/${encodeURIComponent(identity.name)}/tiers/${encodeURIComponent(raidId)}/search`,
                          { method: "POST" }
                        );
                        // 409 (busy, or nothing to search from) and 503 (no
                        // search could be queued) are answers, with each
                        // character's outcome; anything else unexpected is not.
                        if (
                          !response.ok &&
                          response.status !== 409 &&
                          response.status !== 503
                        ) {
                          throw new Error("tier_search_failed");
                        }
                        const result =
                          (await response.json()) as DossierTierSearchResponse;
                        // Re-read so the tier shows the search in flight and the
                        // page's polling follows it.
                        if (result.state === "queued") await refreshDossier();
                        return result;
                      }
                    }
                  : {})}
              />
              <DossierLimitations limitations={dossier.limitations} />
            </div>
          </div>
        ) : null}
      </main>
    </DossierCharacterProvider>
  );
}
