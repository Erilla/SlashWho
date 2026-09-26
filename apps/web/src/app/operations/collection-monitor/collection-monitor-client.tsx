"use client";

import {
  collectionMonitorCompletedLimitMax,
  collectionMonitorCompletedPageSize,
  collectionMonitorResponseSchema,
  type CollectionMonitorResponse
} from "@slashwho/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type PollReadResult,
  retryAfterMilliseconds,
  useAuthoritativePoll
} from "../../../lib/use-authoritative-poll";

import { CollectionProgress } from "../../../components/collection-progress";

function characterText(character: {
  region: string;
  realm: string;
  name: string;
}): string {
  return `${character.name} — ${character.realm} (${character.region.toUpperCase()})`;
}

function characterKey(character: {
  region: string;
  realm: string;
  name: string;
}): string {
  return `${character.region}:${character.realm}:${character.name}`;
}

function dateTime(value: string | null): React.ReactNode {
  if (value === null) return "—";
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: "UTC"
      }).format(new Date(value))}
    </time>
  );
}

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0
    ? `${hours}h`
    : `${hours}h ${remainingMinutes}m`;
}

function code(value: string | null): React.ReactNode {
  return value === null ? "—" : <code>{value}</code>;
}

async function readMonitor(
  signal: AbortSignal,
  completedLimit: number
): Promise<PollReadResult<CollectionMonitorResponse>> {
  const response = await fetch(
    `/api/operations/collection-monitor?completedLimit=${completedLimit}`,
    { cache: "no-store", signal }
  );

  if (!response.ok) {
    if (response.status === 429) {
      return { kind: "retry", retryAfterMs: retryAfterMilliseconds(response) };
    }
    if (response.status >= 500) return { kind: "retry" };
    return { kind: "terminal", response };
  }

  const body: unknown = await response.json().catch(() => null);
  const parsed = collectionMonitorResponseSchema.safeParse(body);
  return parsed.success
    ? { kind: "snapshot", value: parsed.data }
    : { kind: "terminal", response };
}

/** A polled snapshot and the completed-run depth it was read at. */
type PolledMonitor = Readonly<{
  monitor: CollectionMonitorResponse;
  completedLimit: number;
}>;

type TerminalState = "complete" | "partial" | "failed";

function terminalStateByCharacter(
  monitor: CollectionMonitorResponse
): Map<string, { name: string; state: TerminalState }> {
  const terminalStates = new Map<
    string,
    { name: string; state: TerminalState }
  >();
  for (const run of monitor.completed) {
    terminalStates.set(characterKey(run.character), {
      name: run.character.name,
      state: run.state
    });
  }
  for (const run of monitor.failed) {
    terminalStates.set(characterKey(run.character), {
      name: run.character.name,
      state: "failed"
    });
  }
  return terminalStates;
}

function publicationAnnouncement(
  previous: CollectionMonitorResponse,
  next: CollectionMonitorResponse
): string | null {
  const before = terminalStateByCharacter(previous);
  const announcements: string[] = [];
  for (const [key, current] of terminalStateByCharacter(next)) {
    if (before.get(key)?.state === current.state) continue;
    announcements.push(`${current.name} collection is ${current.state}.`);
  }
  return announcements.length === 0 ? null : announcements.join(" ");
}

function terminalErrorMessage(response: Response): string {
  if (response.status === 401 || response.status === 403) {
    return "Your operator session is no longer authorized.";
  }
  if (response.status === 404)
    return "The collection monitor is no longer available.";
  return "The collection monitor returned an unexpected response.";
}

/**
 * Presses "Load more" once it scrolls within reach of the bottom of the capped
 * Completed table, so scrolling alone pages in older runs. The button stays a
 * real control for keyboard users and for browsers without the observer.
 */
function useLoadMoreWhenVisible(
  root: React.RefObject<HTMLElement | null>,
  target: React.RefObject<HTMLElement | null>,
  onVisible: (() => void) | undefined
): void {
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  const enabled = onVisible !== undefined;

  useEffect(() => {
    const element = target.current;
    if (!enabled || !element || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onVisibleRef.current?.();
      },
      { root: root.current, rootMargin: "0px 0px 200px 0px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, root, target]);
}

export function CollectionMonitorView({
  monitor,
  loadingMoreCompleted = false,
  autoLoadMoreCompleted = true,
  onLoadMoreCompleted
}: Readonly<{
  monitor: CollectionMonitorResponse;
  loadingMoreCompleted?: boolean;
  /** False after a failed page, so only a deliberate press retries it. */
  autoLoadMoreCompleted?: boolean;
  /** Absent when no older completed runs can be loaded. */
  onLoadMoreCompleted?: () => void;
}>) {
  const completedScrollRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  useLoadMoreWhenVisible(
    completedScrollRef,
    loadMoreRef,
    autoLoadMoreCompleted && !loadingMoreCompleted
      ? onLoadMoreCompleted
      : undefined
  );

  return (
    <main className="page-shell collection-monitor-page">
      <div className="collection-monitor-heading">
        <div>
          <h1>Collection monitor</h1>
          <p>
            Operator view of persisted discovery and character evidence runs.
          </p>
        </div>
        <p>
          Updated <span className="visually-hidden">at </span>
          {dateTime(monitor.generatedAt)}
        </p>
      </div>

      <section className="collection-monitor-section">
        <h2 id="collection-monitor-in-flight">In flight and pending</h2>
        <div className="collection-monitor-table-scroll">
          <table aria-labelledby="collection-monitor-in-flight">
            <thead>
              <tr>
                <th scope="col">Character</th>
                <th scope="col">Status</th>
                <th scope="col">Step</th>
                <th scope="col">Attempt</th>
                <th scope="col">Started</th>
                <th scope="col">Elapsed</th>
                <th scope="col">Retry after</th>
              </tr>
            </thead>
            <tbody>
              {monitor.inFlight.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    No evidence runs are in flight or pending.
                  </td>
                </tr>
              ) : (
                monitor.inFlight.map((run) => (
                  <tr key={characterKey(run.character)}>
                    <th scope="row">{characterText(run.character)}</th>
                    <td>
                      <span className="state-badge" data-state={run.status}>
                        {run.status}
                      </span>
                    </td>
                    <td>
                      {run.collectionProgress ? (
                        <CollectionProgress
                          announce={false}
                          phases={run.collectionProgress}
                          subject={characterText(run.character)}
                        />
                      ) : null}
                    </td>
                    <td>{run.attempt}</td>
                    <td>{dateTime(run.startedAt)}</td>
                    <td>{duration(run.elapsedSeconds)}</td>
                    <td>{dateTime(run.retryAfterAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="collection-monitor-section">
        <h2 id="collection-monitor-completed">Completed</h2>
        <div
          aria-labelledby="collection-monitor-completed"
          className="collection-monitor-table-scroll collection-monitor-table-scroll--capped"
          ref={completedScrollRef}
          role="region"
          tabIndex={0}
        >
          <table aria-labelledby="collection-monitor-completed">
            <thead>
              <tr>
                <th scope="col">Character</th>
                <th scope="col">State</th>
                <th scope="col">Limitation</th>
                <th scope="col">Parse limitation</th>
                <th scope="col">Completed</th>
                <th scope="col">Evidence version</th>
              </tr>
            </thead>
            <tbody>
              {monitor.completed.length === 0 ? (
                <tr>
                  <td colSpan={6}>No completed evidence runs.</td>
                </tr>
              ) : (
                monitor.completed.map((run, index) => (
                  <tr
                    key={`${characterKey(run.character)}:${run.completedAt ?? index}`}
                  >
                    <th scope="row">{characterText(run.character)}</th>
                    <td>
                      <span className="state-badge" data-state={run.state}>
                        {run.state}
                      </span>
                    </td>
                    <td>{code(run.limitationCode)}</td>
                    <td>{code(run.parseLimitationCode)}</td>
                    <td>{dateTime(run.completedAt)}</td>
                    <td>{run.evidenceVersion}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {monitor.hasMoreCompleted ? (
            <div className="collection-monitor-load-more">
              {onLoadMoreCompleted ? (
                <button
                  className="secondary-button"
                  disabled={loadingMoreCompleted}
                  onClick={onLoadMoreCompleted}
                  ref={loadMoreRef}
                  type="button"
                >
                  {loadingMoreCompleted
                    ? "Loading older runs…"
                    : "Load older runs"}
                </button>
              ) : (
                <p>
                  Showing the latest{" "}
                  {monitor.completed.length.toLocaleString("en-GB")} completed
                  runs.
                </p>
              )}
            </div>
          ) : null}
        </div>
      </section>

      <section className="collection-monitor-section">
        <h2 id="collection-monitor-failed">Failed</h2>
        <div className="collection-monitor-table-scroll">
          <table aria-labelledby="collection-monitor-failed">
            <thead>
              <tr>
                <th scope="col">Character</th>
                <th scope="col">Error</th>
                <th scope="col">Stopped</th>
              </tr>
            </thead>
            <tbody>
              {monitor.failed.length === 0 ? (
                <tr>
                  <td colSpan={3}>No failed evidence runs.</td>
                </tr>
              ) : (
                monitor.failed.map((run, index) => (
                  <tr
                    key={`${characterKey(run.character)}:${run.stoppedAt ?? index}`}
                  >
                    <th scope="row">{characterText(run.character)}</th>
                    <td>{code(run.errorCode)}</td>
                    <td>{dateTime(run.stoppedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="collection-monitor-section">
        <h2 id="collection-monitor-discovery-runs">Discovery runs</h2>
        <div className="collection-monitor-table-scroll">
          <table aria-labelledby="collection-monitor-discovery-runs">
            <thead>
              <tr>
                <th scope="col">Character</th>
                <th scope="col">Status</th>
                <th scope="col">Requested</th>
                <th scope="col">Started</th>
                <th scope="col">Finished</th>
                <th scope="col">Attempt</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              {monitor.discoveryRuns.length === 0 ? (
                <tr>
                  <td colSpan={7}>No discovery runs have been requested.</td>
                </tr>
              ) : (
                monitor.discoveryRuns.map((run) => (
                  <tr key={`${characterKey(run.character)}:${run.requestedAt}`}>
                    <th scope="row">{characterText(run.character)}</th>
                    <td>
                      <span className="state-badge" data-state={run.status}>
                        {run.status}
                      </span>
                    </td>
                    <td>{dateTime(run.requestedAt)}</td>
                    <td>{dateTime(run.startedAt)}</td>
                    <td>{dateTime(run.completedAt)}</td>
                    <td>{run.attempt}</td>
                    <td>{code(run.errorCode)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

export function CollectionMonitorClient({
  initialMonitor
}: Readonly<{ initialMonitor: CollectionMonitorResponse }>) {
  const [monitor, setMonitor] = useState(initialMonitor);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const monitorRef = useRef(initialMonitor);
  const [completedLimit, setCompletedLimit] = useState(
    collectionMonitorCompletedPageSize
  );
  const completedLimitRef = useRef(completedLimit);
  const [loadingMoreCompleted, setLoadingMoreCompleted] = useState(false);
  const [autoLoadMoreCompleted, setAutoLoadMoreCompleted] = useState(true);

  const onSnapshot = useCallback((snapshot: CollectionMonitorResponse) => {
    const nextAnnouncement = publicationAnnouncement(
      monitorRef.current,
      snapshot
    );
    monitorRef.current = snapshot;
    setMonitor(snapshot);
    setError(null);
    if (nextAnnouncement) setAnnouncement(nextAnnouncement);
  }, []);

  const onTerminalError = useCallback((response: Response) => {
    setError(terminalErrorMessage(response));
  }, []);

  // Each poll carries the depth it asked for: a poll already in flight when
  // "Load older runs" lands was read shallower, and must not undo that page.
  const readCurrentMonitor = useCallback(
    async (signal: AbortSignal): Promise<PollReadResult<PolledMonitor>> => {
      const completedLimit = completedLimitRef.current;
      const result = await readMonitor(signal, completedLimit);
      return result.kind === "snapshot"
        ? { kind: "snapshot", value: { monitor: result.value, completedLimit } }
        : result;
    },
    []
  );

  const onPolledSnapshot = useCallback(
    ({ monitor: snapshot, completedLimit }: PolledMonitor) => {
      if (completedLimit < completedLimitRef.current) return;
      onSnapshot(snapshot);
    },
    [onSnapshot]
  );

  useAuthoritativePoll({
    active: monitor.hasActiveRuns,
    read: readCurrentMonitor,
    onSnapshot: onPolledSnapshot,
    onTerminalError
  });

  const loadMoreCompleted = useCallback(async () => {
    const nextLimit = Math.min(
      collectionMonitorCompletedLimitMax,
      completedLimitRef.current + collectionMonitorCompletedPageSize
    );
    setLoadingMoreCompleted(true);
    setAutoLoadMoreCompleted(true);
    let loaded = false;
    try {
      const result = await readMonitor(new AbortController().signal, nextLimit);
      if (result.kind === "snapshot") {
        loaded = true;
        completedLimitRef.current = nextLimit;
        setCompletedLimit(nextLimit);
        onSnapshot(result.value);
      } else if (result.kind === "terminal") {
        onTerminalError(result.response);
      }
    } catch {
      // Handled below: the button stays for a deliberate retry.
    } finally {
      // Without this, a failing page would be re-requested the moment the
      // still-visible button re-arms the observer.
      if (!loaded) setAutoLoadMoreCompleted(false);
      setLoadingMoreCompleted(false);
    }
  }, [onSnapshot, onTerminalError]);

  const canLoadMoreCompleted =
    monitor.hasMoreCompleted &&
    completedLimit < collectionMonitorCompletedLimitMax;

  return (
    <>
      <p className="visually-hidden" aria-live="polite" role="status">
        {announcement}
      </p>
      {error ? (
        <p className="view-error" role="alert">
          {error}
        </p>
      ) : null}
      <CollectionMonitorView
        autoLoadMoreCompleted={autoLoadMoreCompleted}
        loadingMoreCompleted={loadingMoreCompleted}
        monitor={monitor}
        onLoadMoreCompleted={
          canLoadMoreCompleted ? () => void loadMoreCompleted() : undefined
        }
      />
    </>
  );
}
