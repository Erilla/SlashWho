"use client";

import {
  collectionMonitorResponseSchema,
  type CollectionMonitorResponse
} from "@slashwho/contracts";
import { useCallback, useRef, useState } from "react";

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
  signal: AbortSignal
): Promise<PollReadResult<CollectionMonitorResponse>> {
  const response = await fetch("/api/operations/collection-monitor", {
    cache: "no-store",
    signal
  });

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

export function CollectionMonitorView({
  monitor
}: Readonly<{ monitor: CollectionMonitorResponse }>) {
  return (
    <main className="page-shell collection-monitor-page">
      <div className="collection-monitor-heading">
        <div>
          <h1>Collection monitor</h1>
          <p>Operator view of persisted character evidence runs.</p>
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
        <div className="collection-monitor-table-scroll">
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

  useAuthoritativePoll({
    active: monitor.hasActiveRuns,
    read: readMonitor,
    onSnapshot,
    onTerminalError
  });

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
      <CollectionMonitorView monitor={monitor} />
    </>
  );
}
