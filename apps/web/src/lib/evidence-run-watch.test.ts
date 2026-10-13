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
  return {
    id,
    state,
    version,
    key: { region: "eu" as const, realm: "silvermoon", name: id },
    evidenceState: "scanning" as const,
    collectionProgress: []
  };
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

  it("never re-reads for step moves, even beyond the former progress gap", () => {
    const { watch, advance } = watchAt();
    watch.fullRead([first]);
    watch.observe([run(first, "running", "a")]);
    for (let step = 0; step < 30; step++) {
      advance(10_000);
      expect(watch.observe([run(first, "running", `step:${step}`)])).toEqual({
        kind: "unchanged",
        delayMs: 500
      });
    }
  });

  it("coalesces publishes under a fixed deadline and reads immediately on final settlement", () => {
    const third = "10000000-0000-4000-8000-000000000015";
    const { watch, advance } = watchAt();
    watch.fullRead([first, second, third]);
    expect(
      watch.observe([
        run(first, "settled"),
        run(second, "running"),
        run(third, "queued")
      ]).kind
    ).toBe("unchanged");
    advance(8_000);
    expect(
      watch.observe([
        run(first, "settled"),
        run(second, "settled"),
        run(third, "running")
      ]).kind
    ).toBe("unchanged");
    advance(2_000);
    expect(
      watch.observe([
        run(first, "settled"),
        run(second, "settled"),
        run(third, "running")
      ])
    ).toEqual({ kind: "reread" });
    watch.fullRead([third]);
    expect(watch.observe([run(third, "settled")])).toEqual({ kind: "reread" });
  });

  it("waits at least the last full-read duration for intermediate publishes", () => {
    const { watch, advance } = watchAt();
    watch.fullRead([first, second], 15_000);
    const runs = [run(first, "settled"), run(second, "running")];
    expect(watch.observe(runs).kind).toBe("unchanged");
    advance(10_000);
    expect(watch.observe(runs).kind).toBe("unchanged");
    advance(5_000);
    expect(watch.observe(runs)).toEqual({ kind: "reread" });
  });

  it("reads immediately when the last run disappears, and coalesces an intermediate disappearance", () => {
    const { watch, advance } = watchAt();
    watch.fullRead([first, second]);
    expect(watch.observe([run(second, "running")]).kind).toBe("unchanged");
    advance(1_000);
    expect(watch.observe([])).toEqual({ kind: "reread" });
  });

  it("does not reset the stale-full-read fallback when the watched set shrinks", () => {
    const { watch } = watchAt();
    expect(watch.fullRead([first, second])).toBe(0);
    expect(watch.fullRead([first, second])).toBe(1_000);
    expect(watch.fullRead([second])).toBe(2_000);
    expect(watch.fullRead([second])).toBe(4_000);
  });

  it("counts a dossier another read showed without resetting the poll's fallback", () => {
    const { watch } = watchAt();
    watch.fullRead([first]);
    watch.shown([second]);
    expect(watch.watching()).toEqual([second]);
    expect(watch.fullRead([second])).toBe(1_000);
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
