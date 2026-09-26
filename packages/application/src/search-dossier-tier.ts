import type {
  DossierTierSearchOutcome,
  DossierTierSearchResponse
} from "@slashwho/contracts";
import type { DiscoveryQueue, Repositories } from "@slashwho/database";
import { canonicalCharacterId, type CharacterKey } from "@slashwho/domain";

import type { MeasurementScope } from "./measurement";
import {
  searchCharacterTier,
  type SearchCharacterTierResult
} from "./search-character-tier";
import { tierSearchWindow, type TierSearchSubject } from "./tier-search";

/**
 * The most tier searches one press may queue (#449). Each run keeps its own
 * request cap, so this bounds what one press can spend. Only the searches a
 * press queues, or tries to and fails, count against it: a character that is
 * cooling down, collecting or has nothing to add to takes no place, so a
 * later press reaches the characters after it. It is no lower than the
 * largest dossier display cap; characters a press cannot reach are reported
 * as `over_limit`, never dropped.
 */
export const DOSSIER_TIER_SEARCH_CHARACTER_LIMIT = 50;

export type DossierTierSearchCharacterOutcome =
  | Exclude<SearchCharacterTierResult, { kind: "unknown_tier" }>
  /** Beyond the most one press may queue, so nothing was reserved. */
  | Readonly<{ kind: "over_limit" }>
  /** The reservation or the queue failed for this character alone. */
  | Readonly<{ kind: "failed" }>;

export type DossierTierSearchCharacterResult = Readonly<{
  key: CharacterKey;
  displayName: string;
  outcome: DossierTierSearchCharacterOutcome;
}>;

export type SearchDossierTierResult =
  | Readonly<{ kind: "unknown_tier" }>
  | Readonly<{
      kind: "searched";
      characters: readonly DossierTierSearchCharacterResult[];
    }>;

/**
 * Searches one tier for every included dossier character (#449): the
 * submitted character and each connected one, in the dossier's order.
 *
 * Each character goes through `searchCharacterTier` on its own, so keeps its
 * own reservation, request cap, cooldown and run, and a character that is
 * cooling down or already collecting never stops the others being queued.
 * The caller passes only included characters; a character merged under
 * several names is searched once, under the name the dossier shows.
 */
export async function searchDossierTier(options: {
  subjects: readonly TierSearchSubject[];
  raidId: string;
  at: Date;
  repositories: Pick<Repositories, "evidence">;
  queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
  credentials?: { accountId: string; credentialVersion: number };
  scope?: MeasurementScope;
  limit?: number;
}): Promise<SearchDossierTierResult> {
  if (tierSearchWindow(options.raidId, options.at) === null) {
    return { kind: "unknown_tier" };
  }
  const seen = new Set<string>();
  const distinct = options.subjects.filter((subject) => {
    const ids = [subject.key, ...(subject.aliases ?? [])].map(
      canonicalCharacterId
    );
    if (ids.some((id) => seen.has(id))) return false;
    for (const id of ids) seen.add(id);
    return true;
  });
  const limit = options.limit ?? DOSSIER_TIER_SEARCH_CHARACTER_LIMIT;

  const characters: DossierTierSearchCharacterResult[] = [];
  const errors: unknown[] = [];
  // Searches this press queued or tried to queue. Refusals cost no request
  // cap, so they take no place (#494 review).
  let attempted = 0;
  // One at a time: each reservation takes the character's lock, and a press
  // is bounded by `limit`, so there is nothing to gain from racing them.
  for (const subject of distinct) {
    const base = { key: subject.key, displayName: subject.displayName };
    if (attempted >= limit) {
      characters.push({ ...base, outcome: { kind: "over_limit" } });
      continue;
    }
    try {
      const outcome = await searchCharacterTier({
        key: subject.key,
        raidId: options.raidId,
        at: options.at,
        repositories: options.repositories,
        queue: options.queue,
        ...(options.credentials ? { credentials: options.credentials } : {}),
        ...(options.scope ? { scope: options.scope } : {})
      });
      // The window was checked above, so no character can answer this.
      if (outcome.kind === "unknown_tier") return outcome;
      if (outcome.kind === "queued") attempted += 1;
      characters.push({ ...base, outcome });
    } catch (error) {
      attempted += 1;
      errors.push(error);
      characters.push({ ...base, outcome: { kind: "failed" } });
    }
  }
  // A press that did nothing but fail is a failed press, as it was for one
  // character: there is no outcome to report but the error.
  if (errors.length > 0 && errors.length === characters.length) {
    throw errors[0];
  }
  return { kind: "searched", characters };
}

function outcomeOf(
  outcome: DossierTierSearchCharacterOutcome
): Pick<DossierTierSearchOutcome, "outcome" | "searchableAgainAt"> {
  switch (outcome.kind) {
    case "busy":
      return {
        outcome: !outcome.searchingThisTier
          ? "busy"
          : outcome.status === "running"
            ? "running"
            : "already_queued",
        searchableAgainAt: null
      };
    case "recent":
      return {
        outcome: "searched",
        searchableAgainAt: outcome.searchableAgainAt.toISOString()
      };
    default:
      return { outcome: outcome.kind, searchableAgainAt: null };
  }
}

/**
 * The answer to a press: each character's outcome, and a summary led by what
 * the press achieved. `reserved` says whether any search was queued now.
 */
export function dossierTierSearchResponse(
  characters: readonly DossierTierSearchCharacterResult[]
): Readonly<{ reserved: boolean; body: DossierTierSearchResponse }> {
  const outcomes = characters.map((character) => ({
    key: character.key,
    displayName: character.displayName,
    ...outcomeOf(character.outcome)
  }));
  const has = (outcome: DossierTierSearchOutcome["outcome"]) =>
    outcomes.some((item) => item.outcome === outcome);
  const reserved = has("queued");
  // A queue failure is never summarised as "nothing collected yet"
  // (#494 review): with nothing queued, in flight, searched or busy, a
  // failure says what the press met.
  const state: DossierTierSearchResponse["state"] = reserved
    ? "queued"
    : has("running")
      ? "running"
      : has("already_queued")
        ? "queued"
        : has("searched")
          ? "searched"
          : has("busy")
            ? "busy"
            : has("failed")
              ? "failed"
              : "no_evidence";
  const again = outcomes.flatMap((item) =>
    item.searchableAgainAt ? [item.searchableAgainAt] : []
  );
  return {
    reserved,
    body: {
      state,
      searchableAgainAt:
        state === "searched" && again.length > 0
          ? again.reduce((left, right) => (left < right ? left : right))
          : null,
      characters: outcomes
    }
  };
}
