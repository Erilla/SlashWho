import { describe, expect, it } from "vitest";

import {
  findSessionCheck,
  formatLoadSummary,
  parseServerTiming,
  summariseLoads,
  type LoadSample
} from "./load-profile";

describe("parseServerTiming", () => {
  it("reads each metric's duration", () => {
    expect(
      parseServerTiming("total;dur=75, db;dur=40, limiterWait;dur=5")
    ).toEqual({ total: 75, db: 40, limiterWait: 5 });
  });

  it("reads a missing header as no metrics", () => {
    expect(parseServerTiming(null)).toEqual({});
  });

  it("skips a metric that carries no duration", () => {
    expect(parseServerTiming("cache, db;dur=3")).toEqual({ db: 3 });
  });
});

describe("summariseLoads", () => {
  const sample = (
    renderedMs: number,
    server: Record<string, number>,
    settledMs?: number
  ): LoadSample => ({
    shellMs: renderedMs / 2,
    firstResponseMs: renderedMs - 10,
    renderedMs,
    ...(settledMs === undefined ? {} : { settledMs }),
    server,
    earlyRead: true,
    keysSent: false
  });

  it("reports p50, p95 and max for every phase and server metric", () => {
    const summary = summariseLoads([
      sample(100, { total: 50, db: 30 }),
      sample(200, { total: 60, db: 20 }),
      sample(300, { total: 70, db: 10 })
    ]);

    expect(summary.count).toBe(3);
    expect(summary.phases.renderedMs).toEqual({ p50: 200, p95: 290, max: 300 });
    expect(summary.server.db).toEqual({ p50: 20, p95: 29, max: 30 });
  });

  it("summarises settle time only over the loads that had to settle", () => {
    // Break caught: averaging a missing settle time in as zero would make a
    // scenario whose evidence was already complete look instantly settled.
    const summary = summariseLoads([sample(100, {}, 900), sample(100, {})]);
    expect(summary.phases.settledMs).toEqual({ p50: 900, p95: 900, max: 900 });
  });

  it("reports how long after the publish each load settled, and its reads", () => {
    // #690: a settle time only means something against when the worker
    // published, and a faster settle must not come from more full reads.
    const summary = summariseLoads([
      {
        ...sample(100, {}, 1_300),
        publishedMs: 1_000,
        requests: { dossier: 2, progress: 4 }
      },
      { ...sample(100, {}, 900), requests: { dossier: 1 } }
    ]);
    expect(summary.phases.publishedMs).toEqual({
      p50: 1_000,
      p95: 1_000,
      max: 1_000
    });
    expect(summary.phases.settleLagMs).toEqual({
      p50: 300,
      p95: 300,
      max: 300
    });
    expect(summary.requests).toEqual({
      dossier: { p50: 2, p95: 2, max: 2 },
      progress: { p50: 4, p95: 4, max: 4 }
    });
  });

  it("counts the loads whose read started early and the loads that sent keys", () => {
    const summary = summariseLoads([
      { ...sample(100, {}), earlyRead: false, keysSent: true },
      sample(100, {}),
      sample(100, {})
    ]);
    expect(summary.earlyReads).toBe(2);
    expect(summary.keysSent).toBe(1);
  });

  it("leaves a phase out when no load reached it", () => {
    const summary = summariseLoads([sample(100, {})]);
    expect(summary.phases.settledMs).toBeUndefined();
  });
});

describe("formatLoadSummary", () => {
  it("prints one row per phase and server metric", () => {
    const text = formatLoadSummary(
      "warm",
      summariseLoads([
        {
          shellMs: 10,
          firstResponseMs: 20,
          renderedMs: 30,
          server: { total: 8 },
          earlyRead: true,
          keysSent: false
        }
      ]),
      { databaseRttMs: undefined }
    );
    expect(text.split("\n")).toEqual([
      "warm (1 loads, no injected database RTT)",
      "  shell                 p50      10  p95      10  max      10",
      "  firstResponse         p50      20  p95      20  max      20",
      "  rendered              p50      30  p95      30  max      30",
      "  server total          p50       8  p95       8  max       8",
      "  early read fired      1 of 1 loads",
      "  saved keys sent       0 of 1 loads"
    ]);
  });

  it("states the injected database round trip", () => {
    // Break caught: two runs at different PROFILE_DB_RTT_MS settings print
    // identical headers and get compared as if they were like for like.
    const text = formatLoadSummary("warm", summariseLoads([]), {
      databaseRttMs: 5
    });
    expect(text.split("\n")[0]).toBe(
      "warm (0 loads, database RTT +5 ms injected)"
    );
  });
});

describe("findSessionCheck", () => {
  const session = (startMs: number, endMs?: number) => ({
    path: "GET /api/account/session",
    startMs,
    ...(endMs === undefined ? {} : { endMs })
  });

  it("takes the session request that finished last before the read", () => {
    // The account hook's check finishes first; the read waits on the second.
    expect(findSessionCheck([session(90, 110), session(95, 130)], 131)).toEqual(
      { startMs: 95, endMs: 130 }
    );
  });

  it("finds none when the read started before any session request finished", () => {
    // Break caught: an anonymous read's concurrent account check reported as
    // a check the read waited on.
    expect(findSessionCheck([session(90, 140)], 60)).toBeUndefined();
    expect(findSessionCheck([session(90)], 120)).toBeUndefined();
  });

  it("ignores other requests and a load with no read", () => {
    expect(
      findSessionCheck([{ path: "GET /api/other", startMs: 1, endMs: 2 }], 10)
    ).toBeUndefined();
    expect(findSessionCheck([session(1, 2)], undefined)).toBeUndefined();
  });
});
