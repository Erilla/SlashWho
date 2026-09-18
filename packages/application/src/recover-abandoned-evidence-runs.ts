/** One evidence run the reservation gate currently counts as active. */
export type ActiveEvidenceRun = Readonly<{
  runId: string;
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
};

export type AbandonedEvidenceQueue = {
  /**
   * The subset of `jobIds` whose evidence job can no longer run: settled,
   * cancelled, failed, or archived out of the job table entirely.
   */
  settledEvidenceJobIds(
    jobIds: readonly string[]
  ): Promise<readonly string[]>;
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
  limit: number;
}>;

/**
 * Releases every evidence run nothing is working on any more, so the character
 * it belongs to can be collected again. Returns how many runs it released.
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
 * Like the other sweeps, this only releases. It enqueues nothing: the released
 * character falls back to its previous evidence, and the next reader -- or the
 * resume sweep, if the previous run left a deadline -- reserves a fresh run.
 */
export async function recoverAbandonedEvidenceRuns(
  evidence: AbandonableEvidenceStore,
  queue: AbandonedEvidenceQueue,
  options: RecoverAbandonedEvidenceRunsOptions
): Promise<number> {
  const active = await evidence.listActive(options.limit);
  if (active.length === 0) return 0;

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
  if (abandoned.length === 0) return 0;

  // The repository guards the write on the active statuses, so a run that
  // published between the read and the write is not counted here.
  return evidence.releaseAbandoned(abandoned.map((run) => run.runId));
}
