"use client";

import {
  applicantDossierSchema,
  dossierRefreshResponseSchema,
  dossierResearchStatusSchema,
  dossierStartResponseSchema,
  dossierTierSearchResponseSchema,
  evidenceRunProgressResponseSchema,
  safeApiErrorSchema,
  type ApplicantDossier,
  type CharacterKey,
  type EvidenceRunProgressResponse
} from "@slashwho/contracts";
import {
  canonicalCharacterId,
  formatCharacterDisplayName
} from "@slashwho/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  dossierApiPath,
  dossierJobApiPath,
  dossierStartApiPath,
  evidenceRunsApiPath,
  fetchDossierApi,
  parseDossierResponse,
  type DossierApiResult
} from "../../../../../lib/dossier-api";
import { createEvidenceRunWatch } from "../../../../../lib/evidence-run-watch";
import { raiderIoCharacterUrl } from "../../../../../lib/dossier-path";
import { fetchFirstDossierRead } from "../../../../../lib/early-dossier-read";
import { evidenceFilter } from "../../../../../lib/character-visibility";
import { dossierTitle } from "../../../../../lib/dossier-title";
import {
  createBackoff,
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
import { DossierGuildHistory } from "../../../../../components/dossier-guild-history";
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
const researchingStatus = "Researching applicant dossier…";
const unexpectedDossierMessage = "The dossier returned an unexpected response.";
const unexpectedResearchMessage =
  "The applicant research returned an unexpected response.";
const unreachableDossierMessage =
  "The dossier could not be loaded. Please check your connection.";

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

/** Whether the dossier is only the submitted character, with nothing linked. */
function isRootOnly(value: ApplicantDossier | null): boolean {
  return (
    value?.characters.some((character) => character.source === "submitted") ??
    false
  );
}

function isAbortError(caught: unknown): boolean {
  return caught instanceof Error && caught.name === "AbortError";
}

function evidenceStatesByCharacter(value: ApplicantDossier | null) {
  return new Map(
    (value?.characters ?? [])
      .filter((character) => !character.excluded)
      .map((character) => [
        canonicalCharacterId(character.key),
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
  const terminalPollError = useRef(unexpectedDossierMessage);
  const previousDossier = useRef(initialDossier);
  const [researchFailed, setResearchFailed] = useState(false);
  const [identityHidden, setIdentityHidden] = useState(false);
  const [identitySlot, setIdentitySlot] = useState<HTMLElement | null>(null);
  const identityRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState(
    initialDossier
      ? null
      : jobId
        ? researchingStatus
        : "Loading applicant dossier…"
  );
  const hasExpandedDossier = useRef(false);
  const requestSequence = useRef(0);
  const appliedSequence = useRef(0);
  // The runs the shown dossier is waiting on (#690). The poll asks after these
  // and re-reads the dossier only once one of them has moved.
  const [runWatch] = useState(createEvidenceRunWatch);
  // The dossier the poll's own read produced, which it has already counted.
  const polledDossier = useRef<ApplicantDossier | null>(null);
  useEffect(() => {
    // Any other read that shows a dossier is a full read too: the first one,
    // research, a refresh, a tier search.
    if (dossier !== polledDossier.current)
      runWatch.shown(dossier?.evidenceRunIds ?? []);
  }, [dossier, runWatch]);

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
  const dossierApi = useMemo(() => dossierApiPath(identity), [identity]);

  /**
   * Shows a dossier read in place of whatever was showing, and clears the
   * errors an earlier read left. A read that took a sequence number claims it,
   * so an older response still in flight cannot replace this one. `keepError`
   * leaves a research error standing, for a read that only fills in the view
   * while that research is still being followed.
   */
  const showDossier = useCallback(
    (
      value: ApplicantDossier,
      {
        sequence,
        expanded = true,
        keepError = false
      }: Readonly<{
        sequence?: number;
        expanded?: boolean;
        keepError?: boolean;
      }> = {}
    ) => {
      if (sequence !== undefined) appliedSequence.current = sequence;
      hasExpandedDossier.current = expanded;
      setDossier(value);
      setInitialError(null);
      if (!keepError) setError(null);
    },
    []
  );

  // A manually connected character changes the dossier immediately, so read it
  // back rather than reloading the page and discarding the polls in flight.
  const refreshDossier = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const result = await fetchDossierApi(dossierApi, applicantDossierSchema, {
      cache: "no-store"
    });
    if (result.kind !== "ok" || sequence < appliedSequence.current) return;
    showDossier(result.data, { sequence });
    setPollUnavailable(false);
    setPollStopped(false);
  }, [dossierApi, showDossier]);

  useEffect(() => {
    const controller = new AbortController();

    async function readInitialDossier() {
      const result = await fetchDossierApi(
        `${dossierApi}?scope=initial`,
        applicantDossierSchema,
        { cache: "no-store", signal: controller.signal }
      );
      if (controller.signal.aborted || hasExpandedDossier.current) return;
      if (result.kind === "refused") {
        setInitialError(apiError(result.response, result.body));
      } else if (result.kind === "unexpected") {
        setInitialError(unexpectedDossierMessage);
      } else {
        setDossier(result.data);
      }
    }

    // A character new to discovery may already be claimed in another root's
    // snapshot, and a stale root still has its previous one; either is more
    // than the root-only view, so read it while the job runs. Discovery not
    // being ready yet is the expected answer otherwise, and leaves the
    // initial view in place.
    async function readKnownDossier() {
      const sequence = ++requestSequence.current;
      const result = await fetchFirstDossierRead(
        dossierApi,
        applicantDossierSchema,
        { cache: "no-store", signal: controller.signal }
      );
      if (
        result.kind !== "ok" ||
        controller.signal.aborted ||
        sequence < appliedSequence.current
      )
        return;
      showDossier(result.data, { sequence, keepError: true });
    }

    if (!initialDossier && activeJobId) {
      void readInitialDossier().catch((caught) => {
        if (isAbortError(caught)) return;
        if (controller.signal.aborted || hasExpandedDossier.current) return;
        setInitialError(unreachableDossierMessage);
      });
      // A direct visit reached its job through a full read already.
      if (!hasExpandedDossier.current)
        void readKnownDossier().catch(() => undefined);
    }

    return () => controller.abort();
  }, [activeJobId, dossierApi, initialDossier, showDossier]);

  useEffect(() => {
    if (activeJobId || initialDossier) return;

    const controller = new AbortController();

    async function readCompletedDossier() {
      const sequence = ++requestSequence.current;
      const result = await fetchDossierApi(dossierApi, applicantDossierSchema, {
        cache: "no-store",
        signal: controller.signal
      });
      if (controller.signal.aborted || sequence < appliedSequence.current)
        return;
      if (result.kind === "refused") {
        setError(apiError(result.response, result.body));
      } else if (result.kind === "unexpected") {
        setError(unexpectedDossierMessage);
      } else {
        showDossier(result.data, { sequence });
      }
      setStatus(null);
    }

    async function startResearch(researchRoot = identity) {
      try {
        const result = await fetchDossierApi(
          dossierStartApiPath,
          dossierStartResponseSchema,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              characterUrl: raiderIoCharacterUrl(researchRoot)
            }),
            cache: "no-store",
            signal: controller.signal
          }
        );
        if (controller.signal.aborted) return;
        if (result.kind !== "ok") {
          setResearchFailed(true);
          setError(
            result.kind === "refused"
              ? apiError(result.response, result.body)
              : unexpectedResearchMessage
          );
          setStatus(null);
          return;
        }
        if (result.data.kind === "job") {
          setActiveJobId(result.data.jobId);
          setStatus(researchingStatus);
          return;
        }
        await readCompletedDossier();
      } catch (caught) {
        if (isAbortError(caught) || controller.signal.aborted) return;
        setResearchFailed(true);
        setError("The applicant research could not be started.");
        setStatus(null);
      }
    }

    async function readCurrentOrStartResearch() {
      try {
        const result = await fetchFirstDossierRead(
          dossierApi,
          applicantDossierSchema,
          { cache: "no-store", signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        if (result.kind === "unexpected") {
          setError(unexpectedDossierMessage);
          setStatus(null);
          return;
        }
        if (result.kind === "refused") {
          const parsedError = safeApiErrorSchema.safeParse(result.body);
          if (
            result.response.status !== 409 ||
            !parsedError.success ||
            parsedError.data.error.code !== "discovery_not_ready"
          ) {
            setError(apiError(result.response, result.body));
            setStatus(null);
            return;
          }
          await startResearch();
          return;
        }
        const current = result.data;
        const rootOnly = isRootOnly(current);
        showDossier(current, { expanded: !rootOnly });
        if (
          canonicalCharacterId(current.root) !== canonicalCharacterId(identity)
        ) {
          await startResearch(current.root);
          return;
        }
        // A provisional list is another root's account shown under this
        // character, so its own discovery still has to run.
        if (rootOnly || current.research.state === "provisional") {
          await startResearch();
          return;
        }
        setStatus(null);
      } catch (caught) {
        if (isAbortError(caught) || controller.signal.aborted) return;
        setError(unreachableDossierMessage);
        setStatus(null);
      }
    }

    void readCurrentOrStartResearch();

    return () => controller.abort();
  }, [activeJobId, dossierApi, identity, initialDossier, showDossier]);

  useEffect(() => {
    if (!activeJobId) return;

    const jobApi = dossierJobApiPath(activeJobId);
    const controller = new AbortController();
    const backoff = createBackoff();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    function schedulePoll() {
      timeout = setTimeout(() => void pollJob(), backoff.next());
    }

    async function readExpandedDossier() {
      const sequence = ++requestSequence.current;
      const result = await fetchDossierApi(dossierApi, applicantDossierSchema, {
        cache: "no-store",
        signal: controller.signal
      });
      if (controller.signal.aborted || sequence < appliedSequence.current)
        return;
      if (result.kind === "refused") {
        if (result.response.status === 409) {
          setStatus(researchingStatus);
          schedulePoll();
          return;
        }
        appliedSequence.current = sequence;
        setError(apiError(result.response, result.body));
      } else if (result.kind === "unexpected") {
        appliedSequence.current = sequence;
        setError(unexpectedDossierMessage);
      } else {
        showDossier(result.data, { sequence });
      }
      setStatus(null);
    }

    async function pollJob() {
      try {
        const result = await fetchDossierApi(
          jobApi,
          dossierResearchStatusSchema,
          { cache: "no-store", signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        if (result.kind !== "ok") {
          setError(
            result.kind === "refused"
              ? apiError(result.response, result.body)
              : unexpectedResearchMessage
          );
          setStatus(null);
          return;
        }
        const job = result.data;
        if (job.status === "complete") {
          await readExpandedDossier();
          return;
        }
        if (job.status === "failed") {
          setResearchFailed(true);
          setError(
            job.error?.message ??
              "The applicant research could not be completed."
          );
          setStatus(null);
          return;
        }
        if (activeJobStates.has(job.status)) schedulePoll();
      } catch (caught) {
        if (isAbortError(caught) || stopped) return;
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
  }, [activeJobId, dossierApi, showDossier]);

  const readDossierPoll = useCallback(
    async (
      signal: AbortSignal
    ): Promise<
      PollReadResult<{ dossier: ApplicantDossier; sequence: number }>
    > => {
      const watched = runWatch.watching();
      if (watched.length > 0) {
        let progress: DossierApiResult<EvidenceRunProgressResponse>;
        try {
          // No credentials: the route reads no provider, so the visitor's
          // keys have no reason to travel with every ask.
          progress = await parseDossierResponse(
            await fetch(evidenceRunsApiPath(watched), {
              cache: "no-store",
              signal
            }),
            evidenceRunProgressResponseSchema
          );
        } catch (caught) {
          if (!signal.aborted) setPollUnavailable(true);
          throw caught;
        }
        if (signal.aborted) return { kind: "retry" };
        if (progress.kind === "ok") {
          const decision = runWatch.observe(progress.data.runs);
          if (decision.kind === "unchanged") {
            setPollUnavailable(false);
            return decision;
          }
        } else if (
          progress.kind === "refused" &&
          progress.response.status === 429
        ) {
          setPollUnavailable(true);
          return {
            kind: "retry",
            retryAfterMs: retryAfterMilliseconds(progress.response)
          };
        }
        // Anything else is answered by a full read, which reports its own
        // failures the way it always has.
      }
      const sequence = ++requestSequence.current;
      let result: DossierApiResult<ApplicantDossier>;
      try {
        result = await fetchDossierApi(dossierApi, applicantDossierSchema, {
          cache: "no-store",
          signal
        });
      } catch (caught) {
        if (!signal.aborted && sequence >= appliedSequence.current)
          setPollUnavailable(true);
        throw caught;
      }
      if (signal.aborted || sequence < appliedSequence.current)
        return { kind: "retry" };
      if (result.kind === "ok") {
        // Watched now, not after the render: the next ask can start first.
        const runIds = result.data.evidenceRunIds ?? [];
        const delayMs = runWatch.fullRead(runIds);
        polledDossier.current = result.data;
        return {
          kind: "snapshot",
          value: { dossier: result.data, sequence },
          // Runs to watch: ask after them next rather than on the backoff.
          delayMs: runIds.length > 0 ? delayMs : undefined
        };
      }
      if (result.kind === "refused") {
        setPollUnavailable(true);
        if (result.response.status === 429) {
          return {
            kind: "retry",
            retryAfterMs: retryAfterMilliseconds(result.response)
          };
        }
        if (result.response.status >= 500) return { kind: "retry" };
        terminalPollError.current = apiError(result.response, result.body);
      } else {
        terminalPollError.current = unexpectedDossierMessage;
      }
      appliedSequence.current = sequence;
      return { kind: "terminal", response: result.response };
    },
    [dossierApi, runWatch]
  );

  const applyFreshDossier = useCallback(
    (snapshot: { dossier: ApplicantDossier; sequence: number }) => {
      if (snapshot.sequence < appliedSequence.current) return;
      showDossier(snapshot.dossier, { sequence: snapshot.sequence });
      setPollUnavailable(false);
    },
    [showDossier]
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
    // Runs to watch are asked after at once, which also records where they
    // were as the dossier was read.
    firstDelayMs: dossier?.evidenceRunIds?.length ? 0 : undefined,
    read: readDossierPoll,
    onSnapshot: applyFreshDossier,
    onTerminalError: applyDossierError
  });

  const visibleError = error ?? initialError;
  const research = dossier?.research;
  const rootOnly = isRootOnly(dossier);
  const rootCharacter = dossier?.characters.find(
    (character) =>
      canonicalCharacterId(character.key) === canonicalCharacterId(identity)
  );
  const rootDisplayName = rootCharacter?.displayName ?? identity.name;
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
  const rootGuild = rootCharacter?.guild;
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
  // instead of floating over whatever the header happens to hold. A group, not
  // a live region: it appears on scroll, which is nothing to announce.
  const identityBadge = (
    <div
      className="dossier-header-identity"
      role="group"
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
                  const result = await fetchDossierApi(
                    dossierApiPath(identity, "refresh"),
                    dossierRefreshResponseSchema,
                    { method: "POST" }
                  );
                  if (result.kind !== "ok") throw new Error("refresh_failed");
                  await refreshDossier();
                  return result.data;
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
              hasGuildHistory={dossier.guildHistory !== undefined}
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
              {dossier.guildHistory ? (
                <DossierGuildHistory
                  characters={dossier.characters}
                  filter={filter}
                  guildHistory={dossier.guildHistory}
                />
              ) : null}
              <DossierRaidList
                filter={filter}
                onShowAllCharacters={visibility.showAll}
                raids={dossier.raids}
                loading={hasLiveEvidence(dossier)}
                limitations={dossier.limitations}
                {...(canAddCharacters
                  ? {
                      onSearchTier: async (raidId: string) => {
                        // 409 (busy, or nothing to search from) and 503 (no
                        // search could be queued) are answers, with each
                        // character's outcome; anything else unexpected is not.
                        const result = await fetchDossierApi(
                          dossierApiPath(identity, "tiers", raidId, "search"),
                          dossierTierSearchResponseSchema,
                          { method: "POST" },
                          { answers: [409, 503] }
                        );
                        if (result.kind !== "ok") {
                          throw new Error("tier_search_failed");
                        }
                        // Re-read so the tier shows the search in flight and the
                        // page's polling follows it.
                        if (result.data.state === "queued")
                          await refreshDossier();
                        return result.data;
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
