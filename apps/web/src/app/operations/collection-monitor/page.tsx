import type { CollectionMonitorResponse } from "@slashwho/contracts";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { loadWebConfig } from "../../../server/config";
import { getContainer } from "../../../server/container";

import { OperatorLogoutButton } from "./operator-logout-button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Collection monitor",
  robots: { index: false, follow: false }
};

function characterText(character: {
  region: string;
  realm: string;
  name: string;
}): string {
  return `${character.name} — ${character.realm} (${character.region.toUpperCase()})`;
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
        <OperatorLogoutButton />
      </div>

      <section className="collection-monitor-section">
        <h2 id="collection-monitor-in-flight">In flight and pending</h2>
        <div className="collection-monitor-table-scroll">
          <table aria-labelledby="collection-monitor-in-flight">
            <thead>
              <tr>
                <th scope="col">Character</th>
                <th scope="col">Status</th>
                <th scope="col">Attempt</th>
                <th scope="col">Started</th>
                <th scope="col">Elapsed</th>
                <th scope="col">Retry after</th>
              </tr>
            </thead>
            <tbody>
              {monitor.inFlight.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    No evidence runs are in flight or pending.
                  </td>
                </tr>
              ) : (
                monitor.inFlight.map((run) => (
                  <tr
                    key={`${run.character.region}:${run.character.realm}:${run.character.name}`}
                  >
                    <th scope="row">{characterText(run.character)}</th>
                    <td>
                      <span className="state-badge" data-state={run.status}>
                        {run.status}
                      </span>
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
                    key={`${run.character.region}:${run.character.realm}:${run.character.name}:${run.completedAt ?? index}`}
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
                    key={`${run.character.region}:${run.character.realm}:${run.character.name}:${run.stoppedAt ?? index}`}
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

export default async function CollectionMonitorPage() {
  // The page proxy applies renewal/expiry cookies to the navigation response.
  // Recheck here before reading data; never trust a client-supplied principal.
  const { collectionMonitor, operatorAuth } = await getContainer();
  const authentication = await operatorAuth.authenticateOperator(
    new Request(
      new URL(
        "/operations/collection-monitor",
        loadWebConfig().operatorAuth.origin
      ),
      { headers: await headers() }
    )
  );
  if (!authentication.principal) {
    redirect("/operations/login");
  }
  return <CollectionMonitorView monitor={await collectionMonitor.list()} />;
}
