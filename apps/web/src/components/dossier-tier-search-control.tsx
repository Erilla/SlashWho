"use client";

import type {
  CharacterKey,
  DossierTierSearch,
  DossierTierSearchCharacter,
  DossierTierSearchOutcome,
  DossierTierSearchResponse
} from "@slashwho/contracts";
import { useState } from "react";

function formatTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

/** Where one character stands, whichever of the dossier or a press said so. */
type Standing =
  "running" | "queued" | "searched" | "failed" | "skipped" | "not_searched";

type CharacterView = Readonly<{ name: string; status: string }>;

export type TierSearchView = Readonly<{
  label: string;
  disabled: boolean;
  summary: string | null;
  characters: readonly CharacterView[];
}>;

const keyOf = (key: CharacterKey) => `${key.region}/${key.realm}/${key.name}`;

function fromDossier(
  character: DossierTierSearchCharacter
): Readonly<{ standing: Standing; status: string }> {
  switch (character.state) {
    case "running":
      return { standing: "running", status: "searching" };
    case "queued":
      return { standing: "queued", status: "queued" };
    case "completed":
      return { standing: "searched", status: "searched" };
    case "partial":
      return {
        standing: "searched",
        status: "searched, stopped at its request cap"
      };
    case "failed":
      return { standing: "failed", status: "search failed" };
    case "not_searched":
      return { standing: "not_searched", status: "not searched" };
  }
}

function fromAnswer(
  character: DossierTierSearchOutcome
): Readonly<{ standing: Standing; status: string }> {
  switch (character.outcome) {
    case "queued":
    case "already_queued":
      return { standing: "queued", status: "queued" };
    case "running":
      return { standing: "running", status: "searching" };
    case "searched":
      return {
        standing: "searched",
        status: character.searchableAgainAt
          ? `searched recently; again after ${formatTime(character.searchableAgainAt)}`
          : "searched recently"
      };
    case "busy":
      return {
        standing: "skipped",
        status: "skipped: another collection is running for it"
      };
    case "no_evidence":
      return {
        standing: "skipped",
        status: "skipped: nothing collected for it yet"
      };
    case "over_limit":
      return {
        standing: "skipped",
        status: "not queued: beyond the most one search may queue"
      };
    case "failed":
      return { standing: "failed", status: "failed: could not be queued" };
  }
}

const noun = (count: number) => (count === 1 ? "character" : "characters");

/**
 * What the control shows for a tier searched across the dossier's characters
 * (#449). The dossier speaks for every character it has a search for; a
 * press's answer fills in the rest -- why a character was skipped, or where a
 * search stands before the dossier has caught up with it. The tier reads
 * "Searched" only once every character has been.
 */
export function tierSearchView(
  tierSearch: DossierTierSearch | undefined,
  answer: DossierTierSearchResponse | null
): TierSearchView {
  const answered = new Map(
    (answer?.characters ?? []).map((character) => [
      keyOf(character.key),
      character
    ])
  );
  const rows: { name: string; standing: Standing; status: string }[] = (
    tierSearch?.characters ?? []
  ).map((character) => {
    const own = fromDossier(character);
    const pressed = answered.get(keyOf(character.key));
    answered.delete(keyOf(character.key));
    return {
      name: character.displayName,
      ...(own.standing === "not_searched" && pressed
        ? fromAnswer(pressed)
        : own)
    };
  });
  // Characters the dossier has not shown yet, in the order the press met them.
  for (const character of answered.values()) {
    rows.push({ name: character.displayName, ...fromAnswer(character) });
  }

  const count = (standing: Standing) =>
    rows.filter((row) => row.standing === standing).length;
  const total = rows.length;
  const searched = count("searched");
  const settled = total > 0 && searched + count("failed") === total;
  const label =
    count("running") > 0
      ? "Searching…"
      : count("queued") > 0
        ? "Search queued"
        : settled
          ? "Searched"
          : searched + count("failed") > 0
            ? "Search remaining characters"
            : "Search this tier";

  let summary: string | null = null;
  if (total > 0) {
    const parts = (
      [
        ["running", "running"],
        ["queued", "queued"],
        ["failed", "failed"],
        ["skipped", "skipped"],
        ["not_searched", "not searched"]
      ] as const
    ).flatMap(([standing, word]) =>
      count(standing) > 0 ? [`${count(standing)} ${word}`] : []
    );
    const again = settled
      ? [
          tierSearch?.searchableAgainAt,
          ...(answer?.characters ?? []).map(
            (character) => character.searchableAgainAt
          )
        ]
          .filter((value): value is string => Boolean(value))
          .sort()[0]
      : undefined;
    summary = [
      searched === total && total > 1
        ? `All ${total} ${noun(total)} searched.`
        : `${searched} of ${total} ${noun(total)} searched.`,
      ...(parts.length > 0 ? [`${parts.join(", ")}.`] : []),
      ...(again ? [`It can be searched again after ${formatTime(again)}.`] : [])
    ].join(" ");
  }

  return {
    label,
    disabled: label === "Searching…" || label === "Search queued" || settled,
    summary,
    characters: rows.map(({ name, status }) => ({ name, status }))
  };
}

/**
 * Asks for a deeper look at one tier (#435) for every character in the
 * dossier (#449): every known guild's logs for the tier are searched for
 * reports that include each character, which finds what its own history
 * leaves out -- guildless kills, nights of wipes, kills from before
 * collection settled.
 *
 * `tierSearch` is the dossier's own view, so the state survives a reload and
 * follows the page's polling. A press's answer adds what the dossier cannot
 * know: why a character was not queued. Each running character's steps are
 * shown beneath its name in the character list.
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

  const view = tierSearchView(tierSearch, answer);
  const disabled = pending || view.disabled;
  const status = failed
    ? "The search could not be queued. Try again later."
    : view.summary;

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
          void onSearch()
            .then(setAnswer)
            .catch(() => setFailed(true))
            .finally(() => setPending(false));
        }}
        title="Searches every guild's logs for this tier for reports that include each of the dossier's characters. Once a day per tier and character."
        type="button"
      >
        {pending ? "Queuing…" : view.label}
      </button>
      {status ? (
        <p className="dossier-tier-search-status" role="status">
          {status}
        </p>
      ) : null}
      {view.characters.length > 0 ? (
        <ul
          aria-label={`${raidName} search by character`}
          className="dossier-tier-search-characters"
        >
          {view.characters.map((character, index) => (
            <li key={`${character.name}-${index}`}>
              <span className="dossier-tier-search-character">
                {character.name}
              </span>
              : {character.status}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
