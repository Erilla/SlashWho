import { describe, expect, it } from "vitest";

import { percentile, summarize } from "./analyze-performance-logs.mts";

const lines = [
  JSON.stringify({
    event: "http_request",
    durationMs: 100,
    dbMs: 10,
    dbMaxCallName: "applicantSnapshots.getByCharacterKey",
    status: 200
  }),
  JSON.stringify({
    event: "http_request",
    durationMs: 200,
    dbMs: 20,
    dbMaxCallName: "applicantSnapshots.getByCharacterKey",
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

  it("tallies the slowest database call by name", () => {
    const summary = summarize(lines, "http_request");
    expect(summary.dbMaxCallNames).toEqual({
      "applicantSnapshots.getByCharacterKey": 2
    });
  });

  it("tallies no names when no record carries one", () => {
    expect(summarize(lines, "discovery_run").dbMaxCallNames).toEqual({});
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

  it("has empty outcomes but counted providers for upstream_throttle", () => {
    const summary = summarize(lines, "upstream_throttle");
    expect(summary.outcomes).toEqual({});
    expect(summary.byOutcome).toEqual({});
    expect(summary.providers).toEqual({
      "raider.io": 1,
      "warcraftlogs.com": 1
    });
  });

  it("breaks percentiles down per outcome", () => {
    const grouped = [
      JSON.stringify({
        event: "evidence_job",
        outcome: "complete",
        durationMs: 1000
      }),
      JSON.stringify({
        event: "evidence_job",
        outcome: "complete",
        durationMs: 1200
      }),
      JSON.stringify({
        event: "evidence_job",
        outcome: "not_claimed",
        durationMs: 5
      }),
      JSON.stringify({
        event: "evidence_job",
        outcome: "not_claimed",
        durationMs: 7
      })
    ];
    const summary = summarize(grouped, "evidence_job");

    expect(summary.count).toBe(4);
    expect(summary.byOutcome.complete!.count).toBe(2);
    expect(summary.byOutcome.not_claimed!.count).toBe(2);
    // The property that matters: a fast outcome's p95 must not be dragged up by
    // a slow one, so each grouped p95 differs from the overall p95.
    expect(summary.byOutcome.not_claimed!.fields.durationMs!.p95).toBe(6.9);
    expect(summary.byOutcome.complete!.fields.durationMs!.p95).toBe(1190);
    expect(summary.fields.durationMs!.p95).not.toBe(
      summary.byOutcome.complete!.fields.durationMs!.p95
    );
    expect(summary.fields.durationMs!.p95).not.toBe(
      summary.byOutcome.not_claimed!.fields.durationMs!.p95
    );
  });

  it("breaks http_request percentiles down per endpoint, then per status", () => {
    const requests = [
      { endpoint: "dossier", status: 200, durationMs: 900 },
      { endpoint: "dossier", status: 200, durationMs: 1100 },
      { endpoint: "dossier", status: 500, durationMs: 30 },
      { endpoint: "account", status: 200, durationMs: 10 },
      { endpoint: "account", status: 200, durationMs: 12 }
    ].map((fields) => JSON.stringify({ event: "http_request", ...fields }));
    const summary = summarize(requests, "http_request");

    // The overall summary is still reported alongside the breakdown.
    expect(summary.count).toBe(5);
    expect(summary.fields.durationMs!.max).toBe(1100);

    const dossier = summary.byEndpoint.dossier!;
    const account = summary.byEndpoint.account!;
    expect(dossier.count).toBe(3);
    expect(account.count).toBe(2);
    // A fast endpoint must not be dragged up by a slow one.
    expect(account.fields.durationMs!.p95).toBe(11.9);
    expect(dossier.fields.durationMs!.max).toBe(1100);

    // A fast failure must not drag a successful endpoint's p50 down.
    expect(dossier.byStatus["200"]).toMatchObject({ count: 2 });
    expect(dossier.byStatus["200"]!.fields.durationMs!.p50).toBe(1000);
    expect(dossier.byStatus["500"]).toMatchObject({ count: 1 });
    expect(dossier.byStatus["500"]!.fields.durationMs!.max).toBe(30);
    expect(Object.keys(account.byStatus)).toEqual(["200"]);

    // http_request carries no outcome, so it forms no outcome groups.
    expect(summary.byOutcome).toEqual({});
  });

  it("counts an endpoint record with no status only at endpoint level", () => {
    const summary = summarize(
      [JSON.stringify({ event: "http_request", endpoint: "dossier" })],
      "http_request"
    );
    expect(summary.byEndpoint.dossier).toEqual({
      count: 1,
      fields: {},
      byStatus: {}
    });
  });

  it("forms no endpoint groups for outcome-bearing events", () => {
    const summary = summarize(
      [
        JSON.stringify({
          event: "evidence_job",
          outcome: "complete",
          durationMs: 1000
        }),
        JSON.stringify({
          event: "discovery_run",
          outcome: "snapshot",
          durationMs: 5
        })
      ],
      "evidence_job"
    );
    expect(summary.byEndpoint).toEqual({});
    expect(summary.byOutcome).toEqual({
      complete: {
        count: 1,
        fields: { durationMs: { p50: 1000, p95: 1000, max: 1000 } }
      }
    });
    expect(summarize(lines, "discovery_run").byEndpoint).toEqual({});
  });

  it("keeps an outcome group even when it has no numeric fields", () => {
    const summary = summarize(
      [JSON.stringify({ event: "discovery_run", outcome: "cancelled" })],
      "discovery_run"
    );
    expect(summary.byOutcome.cancelled).toEqual({ count: 1, fields: {} });
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
