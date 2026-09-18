import type { Repositories, DiscoveryQueue } from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";

import { measuredRepositories } from "./measured-repositories";
import type { MeasurementScope } from "./measurement";
import { refreshMode, type RefreshMode } from "./refresh-mode";

export type RefreshCharacterResult = Readonly<{
  mode: RefreshMode;
  /** The collection this refresh was measured against, null if never collected. */
  lastCollectedAt: Date | null;
  /** Terminal marks a rebuild forgot; 0 on an ordinary refresh. */
  clearedTiers: number;
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
  /**
   * Refresh is the one path a reader can trigger collection from, so its
   * database work is measured like every other endpoint's rather than leaving
   * the load it causes invisible in the logs.
   */
  scope?: MeasurementScope;
  /**
   * Forget every terminal mark first, so the character's whole history is
   * collected again. Operator-only: deliberately unreachable from the
   * unauthenticated dossier refresh route.
   */
  rebuild?: boolean;
}): Promise<RefreshCharacterResult> {
  const evidence = options.scope
    ? measuredRepositories(
        { evidence: options.repositories.evidence },
        options.scope
      ).evidence
    : options.repositories.evidence;
  const completed = await evidence.getCompleted(options.key);
  const lastCollectedAt = completed?.run.completedAt ?? null;
  const mode: RefreshMode = options.rebuild
    ? "rebuild"
    : refreshMode(lastCollectedAt, options.at, options.cooldownMs);

  // Clearing the marks *is* the rebuild. Nothing stored is deleted: the
  // existing kills, wipes and tier bests stay readable until their
  // replacements arrive, and the ordinary run, retry and budget machinery
  // drains the backlog across as many hourly windows as it takes. Doing the
  // work synchronously would exhaust the allowance and abandon the character
  // part-way, which is precisely the failure of 2026-09-17.
  const clearedTiers = options.rebuild
    ? await evidence.clearTerminalTiers(options.key)
    : 0;

  const reservation = await evidence.reserve({
    key: options.key,
    freshnessCutoff: options.at,
    at: options.at
  });
  if (reservation.kind === "reserved") {
    const queueJobId = await options.queue.enqueueCharacterEvidence(
      reservation.run.id,
      {
        enqueuedAt: options.at.toISOString(),
        // The queue knows `full` and `light` only. A rebuild is an ordinary
        // full run over cleared marks -- what it adds is what it no longer
        // skips, not extra work in this run.
        mode: mode === "light" ? "light" : "full"
      }
    );
    await evidence.markEnqueued(reservation.run.id, queueJobId);
  }
  return { mode, lastCollectedAt, clearedTiers };
}
