import { describe, expect, it } from "vitest";

import { percentile, summarize } from "./analyze-performance-logs.mts";

const lines = [
  JSON.stringify({
    event: "http_request",
    durationMs: 100,
    dbMs: 10,
    status: 200
  }),
  JSON.stringify({
    event: "http_request",
    durationMs: 200,
    dbMs: 20,
    status: 200
  }),
  JSON.stringify({
    event: "discovery_run",
    durationMs: 999,
    outcome: "snapshot"
  }),
  JSON.stringify({
    event: "upstream_throttle",
    retryAfterMs: 500,
    provider: "raider.io"
  }),
  JSON.stringify({
    event: "upstream_throttle",
    retryAfterMs: 1000,
    provider: "warcraftlogs.com"
  }),
  "not json at all",
  ""
];

describe("percentile", () => {
  it("interpolates between samples", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
  });

  it("returns the only sample", () => {
    expect(percentile([7], 95)).toBe(7);
  });

  it("returns 0 for no samples", () => {
    expect(percentile([], 95)).toBe(0);
  });
});

describe("summarize", () => {
  it("summarizes one event type and ignores the rest", () => {
    const summary = summarize(lines, "http_request");
    expect(summary.count).toBe(2);
    expect(summary.fields.durationMs).toEqual({ p50: 150, p95: 195, max: 200 });
    expect(summary.fields.dbMs!.max).toBe(20);
  });

  it("skips unparseable lines rather than throwing", () => {
    expect(() => summarize(lines, "discovery_run")).not.toThrow();
    expect(summarize(lines, "discovery_run").count).toBe(1);
  });

  it("counts outcomes", () => {
    expect(summarize(lines, "discovery_run").outcomes).toEqual({ snapshot: 1 });
  });

  it("reports nothing for an absent event", () => {
    expect(summarize(lines, "evidence_job")).toMatchObject({
      count: 0,
      fields: {}
    });
  });

  it("counts providers for upstream_throttle", () => {
    const summary = summarize(lines, "upstream_throttle");
    expect(summary.providers).toEqual({
      "raider.io": 1,
      "warcraftlogs.com": 1
    });
  });

  it("summarizes upstream_throttle numeric fields", () => {
    const summary = summarize(lines, "upstream_throttle");
    expect(summary.count).toBe(2);
    expect(summary.fields.retryAfterMs).toEqual({
      p50: 750,
      p95: 975,
      max: 1000
    });
  });

  it("has empty outcomes and empty providers for upstream_throttle", () => {
    const summary = summarize(lines, "upstream_throttle");
    expect(summary.outcomes).toEqual({});
    expect(summary.providers).toEqual({
      "raider.io": 1,
      "warcraftlogs.com": 1
    });
  });

  it("skips bare null without throwing", () => {
    const testLines = [
      JSON.stringify({
        event: "http_request",
        durationMs: 100
      }),
      "null",
      JSON.stringify({
        event: "http_request",
        durationMs: 200
      })
    ];
    expect(() => summarize(testLines, "http_request")).not.toThrow();
    expect(summarize(testLines, "http_request").count).toBe(2);
  });

  it("skips JSON arrays without throwing", () => {
    const testLines = [
      JSON.stringify({
        event: "http_request",
        durationMs: 100
      }),
      "[1,2]",
      JSON.stringify({
        event: "http_request",
        durationMs: 200
      })
    ];
    expect(() => summarize(testLines, "http_request")).not.toThrow();
    expect(summarize(testLines, "http_request").count).toBe(2);
  });

  it("skips JSON strings without throwing", () => {
    const testLines = [
      JSON.stringify({
        event: "http_request",
        durationMs: 100
      }),
      '"just a string"',
      JSON.stringify({
        event: "http_request",
        durationMs: 200
      })
    ];
    expect(() => summarize(testLines, "http_request")).not.toThrow();
    expect(summarize(testLines, "http_request").count).toBe(2);
  });

  it("skips JSON numbers without throwing", () => {
    const testLines = [
      JSON.stringify({
        event: "http_request",
        durationMs: 100
      }),
      "42",
      JSON.stringify({
        event: "http_request",
        durationMs: 200
      })
    ];
    expect(() => summarize(testLines, "http_request")).not.toThrow();
    expect(summarize(testLines, "http_request").count).toBe(2);
  });

  it("skips truncated JSON without throwing", () => {
    const testLines = [
      JSON.stringify({
        event: "http_request",
        durationMs: 100
      }),
      '{"event":"http_request","duration',
      JSON.stringify({
        event: "http_request",
        durationMs: 200
      })
    ];
    expect(() => summarize(testLines, "http_request")).not.toThrow();
    expect(summarize(testLines, "http_request").count).toBe(2);
  });

  it("skips records with no event field without throwing", () => {
    const testLines = [
      JSON.stringify({
        event: "http_request",
        durationMs: 100
      }),
      JSON.stringify({
        durationMs: 150
      }),
      JSON.stringify({
        event: "http_request",
        durationMs: 200
      })
    ];
    expect(() => summarize(testLines, "http_request")).not.toThrow();
    expect(summarize(testLines, "http_request").count).toBe(2);
  });
});
