import type { EvidenceCollectionDomain } from "../repositories";

// Bump when the evidence collector changes in a way that must refresh
// previously completed parse evidence.
// Bump when the evidence shape or provider request strategy changes so old
// snapshots are re-collected instead of being treated as fresh forever.
export const CURRENT_EVIDENCE_VERSION = 15;

/**
 * Per-domain collection versions, for evidence stored indefinitely.
 *
 * Bump one when a collection fix changes what that domain stores: terminal
 * tiers below the new version drop out of `terminalTiers`, re-collect once and
 * settle again, while the other domains stay terminal. `CURRENT_EVIDENCE_VERSION`
 * cannot serve this -- it invalidates everything, which is affordable while
 * nothing is terminal and ruinous when the whole point is to stop re-querying.
 *
 * Whoever writes the next collection fix has to bump the right one. If that
 * habit does not stick, this degrades to the blunt global bump it replaced.
 */
export const CURRENT_COLLECTION_VERSIONS: Readonly<
  Record<EvidenceCollectionDomain, number>
> = {
  kills: 2,
  parses: 2,
  tier_bests: 1
};

/**
 * The collection version of `character_raiderio_tier_reads`. Bump it when a
 * fix changes what a settled tier's Raider.IO first kills collect: every
 * settled tier is then asked once more, and nothing else is re-collected.
 */
export const CURRENT_RAIDER_IO_TIER_READ_VERSION = 1;

export function isEvidenceFresh(
  completedAt: Date,
  retryAfterAt: Date | null,
  freshnessCutoff: Date,
  at = new Date()
): boolean {
  return (
    completedAt >= freshnessCutoff &&
    (retryAfterAt === null || retryAfterAt > at)
  );
}
