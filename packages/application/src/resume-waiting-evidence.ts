import type { CharacterKey } from "@slashwho/domain";
import { fullEvidencePhasePlan } from "./evidence-phase-ledger";

/** The part of the evidence repository a resume sweep needs. */
export type ResumableEvidenceStore = {
  listResumable(limit: number, at: Date): Promise<readonly CharacterKey[]>;
  reserve(input: {
    key: CharacterKey;
    freshnessCutoff: Date;
    at: Date;
    phasePlan?: readonly string[];
  }): Promise<{ kind: string; run: { id: string } }>;
  markEnqueued(runId: string, queueJobId: string): Promise<void>;
};

export type ResumeEvidenceQueue = {
  enqueueCharacterEvidence(
    runId: string,
    meta?: { enqueuedAt?: string }
  ): Promise<string>;
};

export type ResumeWaitingEvidenceOptions = Readonly<{
  freshnessCutoff: Date;
  limit: number;
  at?: Date;
  logger?: { info(value: Record<string, unknown>): void };
}>;

/**
 * Starts collection again for every character whose last run asked to be
 * resumed and whose deadline has passed. Returns how many runs it enqueued.
 *
 * Until this existed, `reserve` was reached only from a dossier read or the
 * refresh endpoint, so a run that deferred itself resumed only if a person
 * happened to load the page -- which made a dossier nobody was watching the
 * one that quietly failed to finish, and made every completeness measurement
 * an artefact of how often somebody looked.
 *
 * Shaped like `recoverPendingSearches`, and deliberately just as thin: it
 * reserves and enqueues, and adds no concurrency, no budget of its own and no
 * second opinion about what is due. The queue still runs one evidence job at a
 * time and the points gate still refuses a run it cannot afford, so a sweep
 * cannot spend more per hour than a reader could.
 *
 * It carries no credentials. A visitor's encrypted Warcraft Logs key belongs
 * to the read that supplied it; a sweep has no visitor, so it reserves
 * anonymously and the run falls back to the worker's own account.
 */
export async function resumeWaitingEvidence(
  evidence: ResumableEvidenceStore,
  queue: ResumeEvidenceQueue,
  options: ResumeWaitingEvidenceOptions
): Promise<number> {
  const at = options.at ?? new Date();
  const due = await evidence.listResumable(options.limit, at);
  let resumed = 0;

  for (const key of due) {
    try {
      const reservation = await evidence.reserve({
        key,
        freshnessCutoff: options.freshnessCutoff,
        at,
        phasePlan: fullEvidencePhasePlan()
      });
      // Anything but `reserved` means a read beat the sweep to this character,
      // or its evidence turned out to be fresh after all. Either way the work
      // is in hand and enqueueing again would only duplicate it.
      if (reservation.kind !== "reserved") continue;
      const queueJobId = await queue.enqueueCharacterEvidence(
        reservation.run.id,
        { enqueuedAt: new Date().toISOString() }
      );
      await evidence.markEnqueued(reservation.run.id, queueJobId);
      resumed += 1;
    } catch (error) {
      // One character that cannot be enqueued must not strand the rest of the
      // batch: this sweep is the only thing driving any of them. The tick
      // still ends healthily and the character is due again on the next one,
      // because nothing about its stored run changed.
      options.logger?.info({
        event: "evidence_resume_failed",
        failure: error instanceof Error ? error.name : "unknown"
      });
    }
  }

  return resumed;
}
