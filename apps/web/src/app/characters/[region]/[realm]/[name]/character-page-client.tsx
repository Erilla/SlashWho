"use client";

import {
  characterResourceSchema,
  historyPageSchema,
  jobStatusResponseSchema,
  safeApiErrorSchema,
  type CharacterResource,
  type HistoryPage,
  type JobStatusResponse
} from "@slashwho/contracts";
import {
  toCharacterPath,
  toRaiderIoUrl,
  type CharacterKey
} from "@slashwho/domain";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { CharacterList } from "../../../../../components/character-list";
import {
  formatRefreshTime,
  RefreshHistory
} from "../../../../../components/refresh-history";
import { RefreshState } from "../../../../../components/refresh-state";

type CharacterPageClientProps = Readonly<{
  identity: CharacterKey;
  initialResource: CharacterResource | null;
  initialHistory: HistoryPage;
  initialJob: JobStatusResponse | null;
  selectedSnapshotId: string | null;
}>;

const activeStates = new Set(["queued", "running", "retrying"]);
const pollDelaysMs = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

function safeResponseError(response: Response, body: unknown): string {
  if (response.status === 404) return "The character was not found.";
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    return retryAfter && /^\d+$/.test(retryAfter)
      ? `Too many requests. Try again in ${retryAfter} seconds.`
      : "Too many requests. Please try again shortly.";
  }
  const parsed = safeApiErrorSchema.safeParse(body);
  return parsed.success
    ? parsed.data.error.message
    : "Character data could not be loaded.";
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "character" : "characters"}`;
}

export function CharacterPageClient({
  identity,
  initialResource,
  initialHistory,
  initialJob,
  selectedSnapshotId
}: CharacterPageClientProps) {
  const [resource, setResource] = useState(initialResource);
  const [history, setHistory] = useState(initialHistory);
  const [job, setJob] = useState(initialJob);
  const [error, setError] = useState<string | null>(
    initialJob?.status === "failed"
      ? (initialJob.error?.message ?? "The refresh could not be completed.")
      : null
  );
  const canonicalPath = useMemo(() => toCharacterPath(identity), [identity]);
  const initialActiveJob = initialResource?.activeJob ?? null;
  const jobId = job
    ? activeStates.has(job.status)
      ? job.jobId
      : undefined
    : initialActiveJob?.jobId;
  const visibleState =
    job && activeStates.has(job.status)
      ? job.status
      : initialActiveJob && !job
        ? initialActiveJob.status
        : resource?.snapshot.state;

  useEffect(() => {
    if (!jobId || selectedSnapshotId) return;

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let attempt = 0;

    async function readJson(response: Response): Promise<unknown> {
      return response.json().catch(() => null);
    }

    async function refreshPublicData() {
      const [resourceResponse, historyResponse] = await Promise.all([
        fetch(`/api/v1${canonicalPath}`, { signal: controller.signal }),
        fetch(`/api/v1${canonicalPath}/history`, {
          signal: controller.signal
        })
      ]);
      const [resourceBody, historyBody] = await Promise.all([
        readJson(resourceResponse),
        readJson(historyResponse)
      ]);
      if (!resourceResponse.ok) {
        setError(safeResponseError(resourceResponse, resourceBody));
        return;
      }
      if (!historyResponse.ok) {
        setError(safeResponseError(historyResponse, historyBody));
        return;
      }
      const parsedResource = characterResourceSchema.safeParse(resourceBody);
      const parsedHistory = historyPageSchema.safeParse(historyBody);
      if (!parsedResource.success || !parsedHistory.success) {
        setError("Character data could not be loaded.");
        return;
      }
      setResource(parsedResource.data);
      setHistory(parsedHistory.data);
      setError(null);
    }

    async function poll() {
      try {
        const response = await fetch(`/api/v1/searches/${jobId}`, {
          signal: controller.signal,
          cache: "no-store"
        });
        const body = await readJson(response);
        if (!response.ok) {
          if (!stopped) setError(safeResponseError(response, body));
          return;
        }
        const parsed = jobStatusResponseSchema.safeParse(body);
        if (!parsed.success) {
          if (!stopped)
            setError("The refresh returned an unexpected response.");
          return;
        }
        if (stopped) return;
        setJob(parsed.data);
        if (parsed.data.status === "complete") {
          await refreshPublicData();
          return;
        }
        if (parsed.data.status === "failed") {
          setError(
            parsed.data.error?.message ?? "The refresh could not be completed."
          );
          return;
        }
        const delay = pollDelaysMs[Math.min(attempt, pollDelaysMs.length - 1)];
        attempt += 1;
        timeout = setTimeout(() => void poll(), delay);
      } catch (caught) {
        if (
          stopped ||
          (caught instanceof Error && caught.name === "AbortError")
        ) {
          return;
        }
        setError("The refresh status could not be loaded. Retrying…");
        const delay = pollDelaysMs[Math.min(attempt, pollDelaysMs.length - 1)];
        attempt += 1;
        timeout = setTimeout(() => void poll(), delay);
      }
    }

    void poll();
    return () => {
      stopped = true;
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [canonicalPath, jobId, selectedSnapshotId]);

  const displayName = resource?.character.name ?? identity.name;
  const location = `${identity.region.toUpperCase()} · ${identity.realm}`;

  return (
    <main className="page-shell">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href="/">Who</Link>
        <span aria-hidden="true">/</span>
        <span>{identity.region.toUpperCase()}</span>
        <span aria-hidden="true">/</span>
        <span>{identity.realm}</span>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{displayName}</span>
      </nav>

      <header className="character-heading">
        <div>
          <h1>{displayName}</h1>
          <p className="identity-meta">{location}</p>
        </div>
        <a
          className="external-link"
          href={resource?.character.raiderIoUrl ?? toRaiderIoUrl(identity)}
        >
          View on Raider.IO ↗
        </a>
      </header>

      <div
        className="refresh-meta"
        aria-label="Refresh status"
        aria-live="polite"
      >
        {visibleState ? <RefreshState state={visibleState} /> : null}
        {resource ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{countLabel(resource.snapshot.characterCount)}</span>
            <span aria-hidden="true">·</span>
            <span>
              Last refreshed{" "}
              <time
                dateTime={resource.snapshot.refreshedAt}
                suppressHydrationWarning
              >
                {formatRefreshTime(resource.snapshot.refreshedAt)}
              </time>
            </span>
          </>
        ) : job && activeStates.has(job.status) ? (
          <span>Looking for connected characters…</span>
        ) : null}
      </div>

      {error ? (
        <p className="view-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="character-layout">
        <section aria-labelledby="characters-heading">
          <h2 className="section-heading" id="characters-heading">
            Characters
          </h2>
          {resource ? (
            <CharacterList characters={resource.snapshot.characters} />
          ) : !error ? (
            <p className="empty-state" aria-live="polite">
              This refresh is in progress.
            </p>
          ) : null}
        </section>
        <RefreshHistory
          items={history.items}
          selectedSnapshotId={selectedSnapshotId}
        />
      </div>
    </main>
  );
}
