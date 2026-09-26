"use client";

import {
  recentDossierSearchesResponseSchema,
  type RecentDossierSearchesResponse
} from "@slashwho/contracts";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { formatRealmName } from "../lib/dossier-title";
import {
  retryAfterMilliseconds,
  useAuthoritativePoll,
  type PollReadResult
} from "../lib/use-authoritative-poll";

type RecentDossierSearch = RecentDossierSearchesResponse["searches"][number];

const startedFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});

async function readRecentSearches(
  signal: AbortSignal
): Promise<PollReadResult<readonly RecentDossierSearch[]>> {
  const response = await fetch("/api/dossiers/recent", {
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
  const parsed = recentDossierSearchesResponseSchema.safeParse(body);
  return parsed.success
    ? { kind: "snapshot", value: parsed.data.searches }
    : { kind: "terminal", response };
}

/**
 * The landing page's list of recently searched characters. It reads once on
 * mount and then keeps polling, so a row's spinner becomes a tick without a
 * reload; the poll pauses while the tab is hidden.
 */
export function RecentDossierSearches() {
  const [searches, setSearches] = useState<
    readonly RecentDossierSearch[] | null
  >(null);
  const onSnapshot = useCallback(
    (next: readonly RecentDossierSearch[]) => setSearches(next),
    []
  );
  // A list that cannot be read is left as it last was rather than replaced by
  // an error: it is a convenience, and the search above it still works.
  const onTerminalError = useCallback(() => undefined, []);

  useEffect(() => {
    const controller = new AbortController();
    readRecentSearches(controller.signal)
      .then((result) => {
        if (result.kind === "snapshot") setSearches(result.value);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useAuthoritativePoll({
    active: true,
    read: readRecentSearches,
    onSnapshot,
    onTerminalError
  });

  if (!searches || searches.length === 0) return null;
  return <RecentDossierSearchesTable searches={searches} />;
}

export function RecentDossierSearchesTable({
  searches
}: Readonly<{ searches: readonly RecentDossierSearch[] }>) {
  return (
    <section className="recent-searches" aria-labelledby="recent-searches">
      <h2 id="recent-searches" className="recent-searches-heading">
        Recent searches
      </h2>
      <table className="recent-searches-table">
        <thead className="visually-hidden">
          <tr>
            <th scope="col">Character</th>
            <th scope="col">Started</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {searches.map((search) => {
            const { region, realm, name } = search.character;
            return (
              <tr key={`${region}/${realm}/${name}`}>
                <td className="recent-searches-character">
                  <Link href={`/dossiers/${region}/${realm}/${name}`}>
                    {search.displayName}-{formatRealmName(realm)}
                  </Link>
                </td>
                <td className="recent-searches-started">
                  <time dateTime={search.searchedAt}>
                    {startedFormat.format(new Date(search.searchedAt))}
                  </time>
                </td>
                <td className="recent-searches-state">
                  <ResearchState state={search.state} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function ResearchState({
  state
}: Readonly<{ state: RecentDossierSearch["state"] }>) {
  if (state === "in_progress") {
    return (
      <span className="recent-searches-status" title="In progress">
        <svg
          aria-hidden="true"
          className="dossier-loading-spinner"
          viewBox="0 0 24 24"
        >
          <circle cx="12" cy="12" r="8" />
        </svg>
        <span className="visually-hidden">In progress</span>
      </span>
    );
  }
  return (
    <span
      className="recent-searches-status recent-searches-status--complete"
      title="Completed"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="m5 12.5 4.5 4.5L19 7.5" />
      </svg>
      <span className="visually-hidden">Completed</span>
    </span>
  );
}
