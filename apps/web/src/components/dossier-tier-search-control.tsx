"use client";

import type {
  DossierTierSearch,
  DossierTierSearchResponse
} from "@slashwho/contracts";
import { useEffect, useState } from "react";

function formatTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

/**
 * Asks for a deeper look at one tier (#435): every known guild's logs for the
 * tier are searched for reports that include the character, which finds what
 * its own history leaves out -- guildless kills, nights of wipes, kills from
 * before collection settled.
 *
 * `tierSearch` is the dossier's own view, so the state survives a reload and
 * follows the page's polling. What a press answered is shown only until the
 * dossier catches up with it.
 */
export function DossierTierSearchControl({
  raidName,
  tierSearch,
  onSearch
}: Readonly<{
  raidName: string;
  tierSearch?: DossierTierSearch | undefined;
  onSearch: () => Promise<DossierTierSearchResponse>;
}>) {
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<DossierTierSearchResponse | null>(null);
  const [failed, setFailed] = useState(false);

  // Once the dossier says where the search stands, it speaks for it: a press's
  // answer would otherwise outlive the search it described.
  const dossierState = tierSearch?.state;
  useEffect(() => {
    setAnswer(null);
  }, [dossierState]);

  const state = tierSearch?.state ?? null;
  const settled = state !== null;
  const status =
    state === "queued"
      ? "Search queued."
      : state === "running"
        ? "Searching guild logs for this tier…"
        : state === "searched"
          ? `Searched. It can be searched again after ${formatTime(tierSearch!.searchableAgainAt)}.`
          : failed
            ? "The search could not be queued. Try again later."
            : answer?.state === "busy"
              ? "Another collection is running for this character. Try again when it finishes."
              : answer?.state === "no_evidence"
                ? "Nothing has been collected for this character yet, so there is nothing to search from."
                : answer?.state === "searched" && answer.searchableAgainAt
                  ? `Searched recently. It can be searched again after ${formatTime(answer.searchableAgainAt)}.`
                  : null;
  const label = pending
    ? "Queuing…"
    : state === "queued" || answer?.state === "queued"
      ? "Search queued"
      : state === "running" || answer?.state === "running"
        ? "Searching…"
        : state === "searched" || answer?.state === "searched"
          ? "Searched"
          : "Search this tier";
  const disabled =
    pending ||
    settled ||
    answer?.state === "queued" ||
    answer?.state === "running" ||
    answer?.state === "searched";

  return (
    <div className="dossier-tier-search">
      <button
        aria-label={`Search guild logs for ${raidName}`}
        className="dossier-refresh-button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setPending(true);
          setFailed(false);
          setAnswer(null);
          void onSearch()
            .then(setAnswer)
            .catch(() => setFailed(true))
            .finally(() => setPending(false));
        }}
        title="Searches every guild's logs for this tier for reports that include this character. Once a day per tier."
        type="button"
      >
        {label}
      </button>
      {status ? (
        <p className="dossier-tier-search-status" role="status">
          {status}
        </p>
      ) : null}
    </div>
  );
}
