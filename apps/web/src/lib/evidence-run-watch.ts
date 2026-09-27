import type { EvidenceRunProgressResponse } from "@slashwho/contracts";

import { createBackoff, pollDelaysMs } from "./use-authoritative-poll";

/**
 * How often a dossier asks after a run that is collecting right now (#690).
 * A run publishes when it finishes, so this is how late the page can be. A run
 * that goes quiet for a while is asked after less often, and a step starting
 * or finishing brings the pace back.
 */
export const runningPollDelaysMs: readonly number[] = [
  ...Array.from({ length: 20 }, () => 500),
  ...Array.from({ length: 10 }, () => 1_000),
  2_000
];

/**
 * How often it asks after runs that are only waiting. A new run normally
 * starts within a second or two, so the first asks stay close together; one
 * that keeps waiting has usually been deferred, and is asked after less often.
 */
export const queuedPollDelaysMs: readonly number[] = [
  500, 500, 500, 500, 1_000, 2_000, 4_000, 8_000, 10_000
];

/**
 * How long to wait after a full read before asking after its runs. The first
 * ask is immediate, so it records where the runs were as the dossier was read;
 * the rest only matter if full reads keep finding nothing new, and fall back to
 * the dossier's own schedule rather than re-reading it in a loop.
 */
const afterFullReadDelaysMs: readonly number[] = [0, ...pollDelaysMs];

type RunProgress = EvidenceRunProgressResponse["runs"][number];

export type EvidenceRunDecision =
  { kind: "reread" } | { kind: "unchanged"; delayMs: number };

/**
 * Watches the evidence runs a dossier is waiting on, between full reads.
 *
 * A run that published, or that is gone, is re-read at once: that is the news
 * the page exists to show. Any other move (a step starting or finishing, a
 * run starting, a deferral) is re-read no more often than the dossier's own
 * backoff, which is how often the page re-read before it watched its runs, so
 * watching never costs more full reads than it replaced.
 */
export function createEvidenceRunWatch(
  now: () => number = () => performance.now()
) {
  let watched: readonly string[] = [];
  let seen: ReadonlyMap<string, string> | undefined;
  let lastFullReadAt = Number.NEGATIVE_INFINITY;
  let progressGap = createBackoff(pollDelaysMs);
  let nextProgressGapMs = progressGap.next();
  let running = createBackoff(runningPollDelaysMs);
  let queued = createBackoff(queuedPollDelaysMs);
  let afterFullRead = createBackoff(afterFullReadDelaysMs);

  /**
   * A full read has landed, naming `ids`: what was seen before it no longer
   * applies. A new set of runs starts the backoff over, as a restarted poll
   * did.
   */
  function landed(ids: readonly string[]) {
    if (ids.join() !== watched.join())
      progressGap = createBackoff(pollDelaysMs);
    nextProgressGapMs = progressGap.next();
    watched = ids;
    seen = undefined;
    lastFullReadAt = now();
    running = createBackoff(runningPollDelaysMs);
    queued = createBackoff(queuedPollDelaysMs);
  }

  return {
    /** The runs being watched: the last full read's. */
    watching(): readonly string[] {
      return watched;
    },

    /**
     * The poll's own full read landed. Returns how long to wait before asking
     * after its runs.
     */
    fullRead(ids: readonly string[]): number {
      landed(ids);
      return afterFullRead.next();
    },

    /**
     * Some other read showed a dossier: research, a refresh, a tier search.
     * It counts as a full read, but the poll's own schedule is unchanged.
     */
    shown(ids: readonly string[]): void {
      landed(ids);
    },

    /** Decides from one progress read of the watched runs. */
    observe(runs: readonly RunProgress[]): EvidenceRunDecision {
      const byId = new Map(runs.map((run) => [run.id, run]));
      const published = watched.some((id) => {
        const run = byId.get(id);
        return run === undefined || run.state === "settled";
      });
      if (published) return { kind: "reread" };

      const moved =
        seen !== undefined &&
        watched.some((id) => seen!.get(id) !== byId.get(id)!.version);
      if (moved && now() - lastFullReadAt >= nextProgressGapMs) {
        return { kind: "reread" };
      }
      // A move not yet due is left unrecorded, so it is still a move when it
      // falls due.
      if (!moved) {
        seen = new Map(watched.map((id) => [id, byId.get(id)!.version]));
      }
      afterFullRead = createBackoff(afterFullReadDelaysMs);
      if (watched.some((id) => byId.get(id)!.state === "running")) {
        queued = createBackoff(queuedPollDelaysMs);
        return {
          kind: "unchanged",
          delayMs: moved ? runningPollDelaysMs[0]! : running.next()
        };
      }
      running = createBackoff(runningPollDelaysMs);
      return { kind: "unchanged", delayMs: queued.next() };
    }
  };
}

export type EvidenceRunWatch = ReturnType<typeof createEvidenceRunWatch>;
