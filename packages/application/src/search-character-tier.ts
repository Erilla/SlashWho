import type {
  CharacterEvidenceRun,
  DiscoveryQueue,
  Repositories
} from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";

import { fullEvidencePhasePlan } from "./evidence-phase-ledger";
import { measuredRepositories } from "./measured-repositories";
import type { MeasurementScope } from "./measurement";
import { TIER_SEARCH_SPACING_MS, tierSearchWindow } from "./tier-search";

export type SearchCharacterTierResult =
  | Readonly<{ kind: "queued" }>
  /**
   * A run is already in flight for the character. `searchingThisTier` says
   * whether it is this very search, which is the queued or running state a
   * reader shows; otherwise the search has to wait for it to finish.
   */
  | Readonly<{
      kind: "busy";
      searchingThisTier: boolean;
      status: CharacterEvidenceRun["status"];
    }>
  /** The per-tier, per-character limit: this tier was searched too recently. */
  | Readonly<{
      kind: "recent";
      status: CharacterEvidenceRun["status"];
      searchedAt: Date;
      searchableAgainAt: Date;
    }>
  /** Nothing is stored yet, so an ordinary collection has to come first. */
  | Readonly<{ kind: "no_evidence" }>
  /** A raid the catalogue has no window for, which has no nights to search. */
  | Readonly<{ kind: "unknown_tier" }>;

/**
 * Queues one explicit search of a character's tier from the dossier (#435).
 *
 * This is the only way to start a new tier search. A capped ranked walk may
 * continue automatically after its retry time, without another button press.
 * The mode is stored on the run, and the
 * queue payload says only `full`.
 */
export async function searchCharacterTier(options: {
  key: CharacterKey;
  /** The Journal raid id the dossier keys the tier by. */
  raidId: string;
  at: Date;
  repositories: Pick<Repositories, "evidence">;
  queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
  credentials?: { accountId: string; credentialVersion: number };
  scope?: MeasurementScope;
}): Promise<SearchCharacterTierResult> {
  if (tierSearchWindow(options.raidId, options.at) === null) {
    return { kind: "unknown_tier" };
  }
  const evidence = options.scope
    ? measuredRepositories(
        { evidence: options.repositories.evidence },
        options.scope
      ).evidence
    : options.repositories.evidence;
  const reservation = await evidence.reserveTierSearch({
    key: options.key,
    raidId: options.raidId,
    at: options.at,
    searchedSince: new Date(options.at.getTime() - TIER_SEARCH_SPACING_MS),
    phasePlan: fullEvidencePhasePlan(),
    credentials: options.credentials
  });
  switch (reservation.kind) {
    case "reserved": {
      const queueJobId = await options.queue.enqueueCharacterEvidence(
        reservation.run.id,
        { enqueuedAt: options.at.toISOString(), mode: "full" }
      );
      await evidence.markEnqueued(reservation.run.id, queueJobId);
      return { kind: "queued" };
    }
    case "active":
      return {
        kind: "busy",
        searchingThisTier:
          reservation.run.mode === "tier_search" &&
          reservation.run.tierSearchRaidId === options.raidId,
        status: reservation.run.status
      };
    case "recent":
      return {
        kind: "recent",
        status: reservation.run.status,
        searchedAt: reservation.run.createdAt,
        searchableAgainAt: new Date(
          reservation.run.createdAt.getTime() + TIER_SEARCH_SPACING_MS
        )
      };
    case "no_evidence":
      return { kind: "no_evidence" };
  }
}
