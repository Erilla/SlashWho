import { describe, expect, it } from "vitest";

import {
  createEvidenceRunWatch,
  queuedPollDelaysMs,
  runningPollDelaysMs
} from "./evidence-run-watch";

const first = "10000000-0000-4000-8000-000000000013";
const second = "10000000-0000-4000-8000-000000000014";

function run(
  id: string,
  state: "queued" | "running" | "settled",
  version: string = state
) {
  return { id, state, version };
}

/** A watch on a clock the test moves by hand. */
function watchAt(start = 0) {
  let now = start;
  const watch = createEvidenceRunWatch(() => now);
  return {
    watch,
    advance(ms: number) {
      now += ms;
    }
  };
}

describe("createEvidenceRunWatch", () => {
  it("asks straight after a full read, then every half second while a run collects", () => {
    const { watch } = watchAt();

    expect(watch.fullRead([first])).toBe(0);
    expect(watch.watching()).toEqual([first]);
    const delays = [0, 1, 2].map(
      () => watch.observe([run(first, "running", "r:a")]) as { delayMs: number }
    );
    expect(delays.map((decision) => decision.delayMs)).toEqual([500, 500, 500]);
  });

  it("re-reads at once when a run publishes or is gone, even on the first ask", () => {
    const { watch } = watchAt();
    watch.fullRead([first, second]);
    expect(
      watch.observe([run(first, "settled"), run(second, "running")])
    ).toEqual({ kind: "reread" });

    watch.fullRead([first, second]);
    expect(watch.observe([run(first, "running")])).toEqual({
      kind: "reread"
    });
  });

  it("re-reads for a step no sooner than the dossier's own backoff", () => {
    // Break caught: re-reading on every step made a short run cost more full
    // reads than the plain backoff it replaced.
    const { watch, advance } = watchAt();
    watch.fullRead([first]);
    watch.observe([run(first, "running", "running:active:pending")]);

    advance(500);
    // Moved, but only half a second after the full read: not yet.
    expect(
      watch.observe([run(first, "running", "running:completed:active")])
    ).toEqual({ kind: "unchanged", delayMs: 500 });
    advance(500);
    // Still moved against what was last recorded, and now due.
    expect(
      watch.observe([run(first, "running", "running:completed:active")])
    ).toEqual({ kind: "reread" });

    // The next step waits two seconds, as the backoff's second read did.
    watch.fullRead([first]);
    watch.observe([run(first, "running", "running:completed:active")]);
    advance(1_500);
    expect(
      watch.observe([run(first, "running", "running:completed:completed")])
    ).toEqual({ kind: "unchanged", delayMs: 500 });
    advance(500);
    expect(
      watch.observe([run(first, "running", "running:completed:completed")])
    ).toEqual({ kind: "reread" });
  });

  it("counts a dossier another read showed as a full read", () => {
    // Break caught: discovery's own dossier read did not count, so a step
    // change straight after it re-read the dossier a second time.
    const { watch, advance } = watchAt();
    watch.fullRead([first]);
    watch.observe([run(first, "queued")]);
    advance(900);
    watch.shown([first]);
    watch.observe([run(first, "queued")]);
    advance(500);
    expect(watch.observe([run(first, "running")])).toEqual({
      kind: "unchanged",
      delayMs: 500
    });
    // It leaves the poll's own schedule alone: its next full read still
    // asks at once.
    expect(watch.fullRead([first])).toBe(0);
  });

  it("starts the backoff over for a new set of runs", () => {
    const { watch, advance } = watchAt();
    watch.fullRead([first]);
    watch.fullRead([first]);
    watch.fullRead([second]);
    watch.observe([run(second, "queued")]);
    advance(1_000);
    expect(watch.observe([run(second, "running")])).toEqual({
      kind: "reread"
    });
  });

  it("slows down while a run is quiet, and while every run only waits", () => {
    const { watch } = watchAt();
    watch.fullRead([first]);
    const running = runningPollDelaysMs.map(
      () => watch.observe([run(first, "running")]) as { delayMs: number }
    );
    expect(running.map((decision) => decision.delayMs)).toEqual([
      ...runningPollDelaysMs
    ]);

    watch.fullRead([second]);
    const queued = queuedPollDelaysMs.map(
      () => watch.observe([run(second, "queued")]) as { delayMs: number }
    );
    expect(queued.map((decision) => decision.delayMs)).toEqual([
      ...queuedPollDelaysMs
    ]);
    expect(watch.observe([run(second, "queued")])).toEqual({
      kind: "unchanged",
      delayMs: queuedPollDelaysMs.at(-1)
    });
  });

  it("falls back to the dossier's own schedule when full reads keep finding nothing new", () => {
    // A dossier that keeps naming a run the progress read leaves out must not
    // be re-read in a tight loop.
    const { watch } = watchAt();
    const delays = [0, 1, 2, 3].map(() => {
      const delay = watch.fullRead([first]);
      expect(watch.observe([])).toEqual({ kind: "reread" });
      return delay;
    });
    expect(delays).toEqual([0, 1_000, 2_000, 4_000]);

    watch.observe([run(first, "running")]);
    expect(watch.fullRead([first])).toBe(0);
  });
});
