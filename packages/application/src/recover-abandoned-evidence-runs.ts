import type {
  StagedEvidenceCollection,
  TerminalTier
} from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";

import {
  fromStagedCollection,
  terminalTiersFromStage,
  type EvidencePublication
} from "./evidence-publication";

/** One evidence run the reservation gate currently counts as active. */
export type ActiveEvidenceRun = Readonly<{
  runId: string;
  /** Whose run it is, so a republished stage can settle its tiers. */
  key: CharacterKey;
  /**
   * Null until `markEnqueued` records the job this run was sent to -- so
   * either a run not yet enqueued, or one whose `markEnqueued` was refused
   * because the worker had already claimed it out of `queued`.
   */
  queueJobId: string | null;
  /** Null until a worker claims the run. */
  startedAt: Date | null;
  createdAt: Date;
}>;

/** The part of the evidence repository a recovery sweep needs. */
export type AbandonableEvidenceStore = {
  listActive(limit: number): Promise<readonly ActiveEvidenceRun[]>;
  releaseAbandoned(runIds: readonly string[]): Promise<number>;
  /**
   * The finished scan an abandoned run was holding on its way to storage, if
   * it got that far. Recovery reads this only for runs it has already decided
   * are abandoned.
   */
  stagedCollection(runId: string): Promise<StagedEvidenceCollection | null>;
  publish(runId: string, input: EvidencePublication): Promise<void>;
  markTerminalTiers(
    key: CharacterKey,
    tiers: readonly TerminalTier[],
    at: Date
  ): Promise<void>;
};

export type AbandonedEvidenceQueue = {
  /**
   * The subset of `jobIds` whose evidence job can no longer run: settled,
   * cancelled, failed, or archived out of the job table entirely.
   */
  settledEvidenceJobIds(jobIds: readonly string[]): Promise<readonly string[]>;
};

export type RecoverAbandonedEvidenceRunsOptions = Readonly<{
  /**
   * The far backstop: a run older than this is released whatever the queue
   * says about it. It exists for the pathological case the queue arm cannot
   * answer, so it must clear the longest life a healthy run can have.
   */
  startedBefore: Date;
  /**
   * The cutoff for a run nothing has ever touched -- no job id and no claim.
   * Such a run cannot be in a deferral chain, so it needs no long margin;
   * minutes are enough to outlast the gap between `reserve` and
   * `markEnqueued`.
   */
  reservedBefore: Date;
  /**
   * How long after a kill its rankings are taken to have settled, for deciding
   * which tiers a republished stage may mark terminal. The same value the
   * collection handler uses, so recovery settles what the original run would
   * have.
   */
  settleMs: number;
  limit: number;
}>;

/** What one sweep did, split by which outcome each run reached. */
export type RecoveredEvidenceRuns = Readonly<{
  /** Runs settled as `failed` with the code `abandoned`. */
  released: number;
  /** Runs completed from the scan they had already paid for. */
  republished: number;
}>;

/**
 * Settles every evidence run nothing is working on any more, so the character
 * it belongs to can be collected again -- by completing it from the scan it
 * had already paid for where there is one, and releasing it where there is
 * not.
 *
 * A run whose worker dies between `claim` and `publish`/`fail` stays `running`
 * for good: `reserve` counts ('queued','running','retrying') as active with no
 * staleness cutoff, so every later dossier read joins a run that is running
 * nowhere, and the resume sweep skips the character as already in hand. An
 * orderly shutdown records an outcome; a hard kill, an OOM, a container pulled
 * by the platform or a database failure mid-publish cannot.
 *
 * Two arms, because neither covers the other:
 *
 * - The queue arm is the one that fires in practice. A job pg-boss has
 *   finished, cancelled, failed or deleted is one no worker will pick up
 *   again, whatever the run row says. It is deliberately patient: pg-boss
 *   moves an expired `active` job to `retry` until its retry limit is spent,
 *   and each of those redeliveries genuinely re-claims and re-collects the
 *   run. Only once the chain is exhausted is nothing working on it, which is
 *   the first moment releasing it is the right answer rather than a duplicate
 *   collection.
 * - The orphan arm covers a run nothing has ever touched: no job id and no
 *   claim, meaning `reserve` created the row and the process died before
 *   `enqueue` returned. It cannot be deferred or mid-collection, so it is
 *   released after minutes rather than hours.
 * - The age arm is the far backstop for anything else that slips past both,
 *   including a run whose `markEnqueued` lost a race to the worker's own
 *   claim and so carries no job id while genuinely running.
 *
 * A run that has not been enqueued *yet* is deliberately exempt from the queue
 * arm: `reserve` inserts the row before `enqueue` returns an id, so asking the
 * queue about it would find nothing and release a run a reader is still
 * starting.
 *
 * The orphan arm is gated on `startedAt` being null rather than merely on the
 * job id, because those are not the same population. `claim` sets
 * `started_at = COALESCE(started_at, now())`, so a claim is recorded even when
 * `markEnqueued` was refused for being too late -- and that run is being
 * collected right now. Releasing it would not be caught by the claim guard:
 * the guard stops the *next* claim, while the attempt already in flight
 * carries on and discards its whole scan at `publish`.
 *
 * An abandoned run holding a staged collection is completed rather than
 * released. The stage exists precisely so a publication that failed on its way
 * to storage is retried without paying for the scan again (#292), and the
 * history scan is 68-86% of what a run costs (#308) -- so a released stage
 * throws away the expensive part of the run, not an incidental part of it. The
 * bytes published here are the same ones a re-claimed attempt would republish;
 * the only novelty is that no worker observed the original attempt finishing.
 *
 * This enqueues nothing either way. A released character falls back to its
 * previous evidence; a republished one is complete, or partial with the
 * deadline its stage carried -- and because recovery runs before the resume
 * pass on the same tick, a partial republication is resumed immediately rather
 * than waiting for somebody to load the dossier.
 */
export async function recoverAbandonedEvidenceRuns(
  evidence: AbandonableEvidenceStore,
  queue: AbandonedEvidenceQueue,
  options: RecoverAbandonedEvidenceRunsOptions
): Promise<RecoveredEvidenceRuns> {
  const nothing: RecoveredEvidenceRuns = { released: 0, republished: 0 };
  const active = await evidence.listActive(options.limit);
  if (active.length === 0) return nothing;

  // Measured from `started_at` where there is one: a run claimed long after it
  // was created is working, not abandoned, and reading `created_at` would
  // release it out from under the worker holding it.
  const overAge = (run: ActiveEvidenceRun): boolean =>
    (run.startedAt ?? run.createdAt).getTime() <
    options.startedBefore.getTime();

  const orphaned = (run: ActiveEvidenceRun): boolean =>
    run.queueJobId === null &&
    run.startedAt === null &&
    run.createdAt.getTime() < options.reservedBefore.getTime();

  const enqueued = active.filter(
    (run): run is ActiveEvidenceRun & { queueJobId: string } =>
      run.queueJobId !== null
  );
  const settled =
    enqueued.length === 0
      ? new Set<string>()
      : new Set(
          await queue.settledEvidenceJobIds(
            enqueued.map((run) => run.queueJobId)
          )
        );

  const abandoned = active.filter(
    (run) =>
      orphaned(run) ||
      overAge(run) ||
      (run.queueJobId !== null && settled.has(run.queueJobId))
  );
  if (abandoned.length === 0) return nothing;

  // Serially, not in parallel: `publish` is a long multi-statement transaction
  // that locks the run row, and the staged population is a handful at most --
  // it is the narrow window between a finished scan and a stored one.
  let republished = 0;
  const releasable: string[] = [];
  for (const run of abandoned) {
    const staged = await evidence.stagedCollection(run.runId);
    if (!staged) {
      releasable.push(run.runId);
      continue;
    }
    try {
      await evidence.publish(run.runId, fromStagedCollection(staged));
    } catch {
      // Two cases, one handler, deliberately. A stage `publish` refuses must
      // not leave the run active for ever; and a run that published for real
      // between the read above and this write throws
      // `character_evidence_run_not_active`, for which `releaseAbandoned`'s
      // own status guard makes the fallback a no-op. Neither needs telling
      // apart to be handled correctly.
      releasable.push(run.runId);
      continue;
    }
    republished += 1;
    // Only after the publication succeeded, for the reason the collection
    // handler gives: a mark that outlived a failed publish would stop the tier
    // being collected while nothing was stored for it. A mark that fails after
    // one succeeded is the harmless direction -- the evidence is stored and
    // the run has left the active set, so releasing it now would be wrong, and
    // all an unmarked tier costs is a re-query.
    const marks = terminalTiersFromStage(staged, options.settleMs);
    if (marks.length > 0) {
      try {
        await evidence.markTerminalTiers(
          run.key,
          marks,
          new Date(staged.completedAt)
        );
      } catch {
        // Left unmarked. The publication stands.
      }
    }
  }

  // One batched write for everything with nothing worth keeping. The
  // repository guards it on the active statuses, so a run that published
  // between the read and the write is not counted here.
  const released =
    releasable.length === 0 ? 0 : await evidence.releaseAbandoned(releasable);
  return { released, republished };
}
