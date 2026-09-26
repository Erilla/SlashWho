import type { Repositories, DiscoveryQueue } from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";

import { measuredRepositories } from "./measured-repositories";
import { fullEvidencePhasePlan } from "./evidence-phase-ledger";
import type { MeasurementScope } from "./measurement";
import { refreshMode, type RefreshMode } from "./refresh-mode";
import {
  killTiersAreSettled,
  type SettledCollectionEvidence
} from "./settled-collection";

export type RefreshCharacterResult = Readonly<{
  mode: RefreshMode;
  /** The collection this refresh was measured against, null if never collected. */
  lastCollectedAt: Date | null;
  /** Terminal marks a rebuild forgot; 0 on an ordinary refresh. */
  clearedTiers: number;
}>;

async function lightCollectionIsSettled(options: {
  key: CharacterKey;
  at: Date;
  cooldownMs: number;
  evidence: Pick<Repositories["evidence"], "getCompleted" | "listStatus"> &
    SettledCollectionEvidence;
}): Promise<boolean> {
  const [completed, stored, terminal, status] = await Promise.all([
    options.evidence.getCompleted(options.key),
    options.evidence.storedEvidenceTiers(options.key),
    options.evidence.terminalTiers(options.key),
    options.evidence.listStatus([options.key])
  ]);
  if (
    completed === null ||
    status.some((run) =>
      ["queued", "running", "retrying"].includes(run.status)
    ) ||
    completed.run.limitationCode !== null ||
    completed.run.parseLimitationCode !== null ||
    stored.lastCleanKillScanAt === undefined ||
    new Date(stored.lastCleanKillScanAt).getTime() <
      options.at.getTime() - options.cooldownMs
  )
    return false;

  return killTiersAreSettled({
    key: options.key,
    completed,
    terminal,
    settledBefore: new Date(options.at.getTime() - options.cooldownMs),
    evidence: options.evidence
  });
}

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
  credentials?: { accountId: string; credentialVersion: number };
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
  /** Emits only static operational facts; callers must not include identity. */
  logger?: { info(value: Record<string, unknown>): void };
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

  if (
    mode === "light" &&
    !options.rebuild &&
    (await lightCollectionIsSettled({
      key: options.key,
      at: options.at,
      cooldownMs: options.cooldownMs,
      evidence
    }))
  ) {
    options.logger?.info({
      event: "light_collection_skipped",
      reason: "all_domains_fresh_terminal"
    });
    return { mode, lastCollectedAt, clearedTiers };
  }

  const reservation = await evidence.reserve({
    key: options.key,
    freshnessCutoff: options.at,
    at: options.at,
    phasePlan: fullEvidencePhasePlan(),
    credentials: options.credentials
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
