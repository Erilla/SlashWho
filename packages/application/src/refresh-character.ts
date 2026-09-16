import type { Repositories, DiscoveryQueue } from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";

import { refreshMode, type RefreshMode } from "./refresh-mode";

export type RefreshCharacterResult = Readonly<{
  mode: RefreshMode;
  /** The collection this refresh was measured against, null if never collected. */
  lastCollectedAt: Date | null;
}>;

/**
 * Re-collects one character on demand, without the evidence-version bump that
 * would sweep every character at once.
 *
 * Passing `at` as the freshness cutoff leaves nothing fresh, so `reserve`
 * admits a run for this character alone. The shared freshness window is
 * untouched, and a collection already in flight is joined rather than
 * duplicated — `reserve` returns it as `active`.
 */
export async function refreshCharacter(options: {
  key: CharacterKey;
  at: Date;
  cooldownMs: number;
  repositories: Pick<Repositories, "evidence">;
  queue: Pick<DiscoveryQueue, "enqueueCharacterEvidence">;
}): Promise<RefreshCharacterResult> {
  const completed = await options.repositories.evidence.getCompleted(
    options.key
  );
  const lastCollectedAt = completed?.run.completedAt ?? null;
  const mode = refreshMode(lastCollectedAt, options.at, options.cooldownMs);

  const reservation = await options.repositories.evidence.reserve({
    key: options.key,
    freshnessCutoff: options.at,
    at: options.at
  });
  if (reservation.kind === "reserved") {
    const queueJobId = await options.queue.enqueueCharacterEvidence(
      reservation.run.id,
      { enqueuedAt: options.at.toISOString(), mode }
    );
    await options.repositories.evidence.markEnqueued(
      reservation.run.id,
      queueJobId
    );
  }
  return { mode, lastCollectedAt };
}
