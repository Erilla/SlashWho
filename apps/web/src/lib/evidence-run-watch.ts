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

/** Watches cheap row progress and folds nearby publishes into one full read. */
export function createEvidenceRunWatch(
  now: () => number = () => performance.now()
) {
  let watched: readonly string[] = [];
  let seen: ReadonlyMap<string, string> | undefined;
  let lastFullReadDurationMs = 0;
  let publishDueAt: number | undefined;
  let running = createBackoff(runningPollDelaysMs);
  let queued = createBackoff(queuedPollDelaysMs);
  let afterFullRead = createBackoff(afterFullReadDelaysMs);

  function landed(ids: readonly string[], durationMs?: number) {
    watched = ids;
    seen = undefined;
    publishDueAt = undefined;
    if (durationMs !== undefined) lastFullReadDurationMs = durationMs;
    running = createBackoff(runningPollDelaysMs);
    queued = createBackoff(queuedPollDelaysMs);
  }

  return {
    /** The last authoritative full read's runs, including pending publishes. */
    watching(): readonly string[] {
      return watched;
    },

    /** A poll full read landed. A stale watched set retains the read backoff. */
    fullRead(ids: readonly string[], durationMs?: number): number {
      landed(ids, durationMs);
      return afterFullRead.next();
    },

    /** An external full read landed; leaves the poll's fallback unchanged. */
    shown(ids: readonly string[], durationMs?: number): void {
      landed(ids, durationMs);
    },

    observe(runs: readonly RunProgress[]): EvidenceRunDecision {
      const byId = new Map(runs.map((run) => [run.id, run]));
      const active = watched.flatMap((id) => {
        const run = byId.get(id);
        return run && run.state !== "settled" ? [run] : [];
      });
      if (active.length < watched.length) {
        // First observed publish fixes the deadline. Later publishes do not
        // postpone it; final settlement overrides it, even on the first poll.
        publishDueAt ??= now() + Math.max(10_000, lastFullReadDurationMs);
        if (active.length === 0 || now() >= publishDueAt)
          return { kind: "reread" };
      }

      const moved =
        seen !== undefined &&
        active.some((run) => seen!.get(run.id) !== run.version);
      seen = new Map(active.map((run) => [run.id, run.version]));
      // An actual active collection breaks the chain of stale full snapshots.
      afterFullRead = createBackoff(afterFullReadDelaysMs);
      let delayMs: number;
      if (active.some((run) => run.state === "running")) {
        queued = createBackoff(queuedPollDelaysMs);
        if (moved) running = createBackoff(runningPollDelaysMs);
        delayMs = running.next();
      } else {
        running = createBackoff(runningPollDelaysMs);
        if (moved) queued = createBackoff(queuedPollDelaysMs);
        delayMs = queued.next();
      }
      return {
        kind: "unchanged",
        delayMs:
          publishDueAt === undefined
            ? delayMs
            : Math.min(delayMs, Math.max(0, publishDueAt - now()))
      };
    }
  };
}

export type EvidenceRunWatch = ReturnType<typeof createEvidenceRunWatch>;
