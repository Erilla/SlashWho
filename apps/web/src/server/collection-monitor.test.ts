import type { EvidenceMonitorRun } from "@slashwho/database";
import { describe, expect, it } from "vitest";

import { createCollectionMonitorService } from "./collection-monitor";

describe("operator collection monitor", () => {
  it("groups the safe projection and computes elapsed time from started_at", async () => {
    const rows: EvidenceMonitorRun[] = [
      {
        key: { region: "eu", realm: "silvermoon", name: "queued" },
        status: "queued",
        evidenceVersion: 13,
        attempt: 0,
        limitationCode: null,
        parseLimitationCode: null,
        retryAfterAt: null,
        errorCode: null,
        startedAt: null,
        completedAt: null
      },
      {
        key: { region: "eu", realm: "silvermoon", name: "retrying" },
        status: "retrying",
        evidenceVersion: 13,
        attempt: 2,
        limitationCode: "rate_limited",
        parseLimitationCode: null,
        retryAfterAt: new Date("2026-09-20T12:15:00Z"),
        errorCode: null,
        startedAt: new Date("2026-09-20T11:45:00Z"),
        completedAt: null
      },
      {
        key: { region: "eu", realm: "silvermoon", name: "partial" },
        status: "partial",
        evidenceVersion: 12,
        attempt: 1,
        limitationCode: "request_cap",
        parseLimitationCode: "parse_request_cap",
        retryAfterAt: null,
        errorCode: null,
        startedAt: new Date("2026-09-20T10:00:00Z"),
        completedAt: new Date("2026-09-20T11:00:00Z")
      },
      {
        key: { region: "eu", realm: "silvermoon", name: "failed" },
        status: "failed",
        evidenceVersion: 13,
        attempt: 3,
        limitationCode: null,
        parseLimitationCode: null,
        retryAfterAt: null,
        errorCode: "warcraft_logs_unavailable",
        startedAt: new Date("2026-09-20T09:00:00Z"),
        completedAt: new Date("2026-09-20T09:30:00Z")
      }
    ];
    const service = createCollectionMonitorService({
      evidence: {
        async listForMonitor() {
          return rows;
        }
      },
      clock: () => new Date("2026-09-20T12:00:00Z")
    });

    await expect(service.list()).resolves.toEqual({
      generatedAt: "2026-09-20T12:00:00.000Z",
      inFlight: [
        {
          character: { region: "eu", realm: "silvermoon", name: "queued" },
          status: "queued",
          attempt: 0,
          startedAt: null,
          elapsedSeconds: null,
          retryAfterAt: null
        },
        {
          character: {
            region: "eu",
            realm: "silvermoon",
            name: "retrying"
          },
          status: "retrying",
          attempt: 2,
          startedAt: "2026-09-20T11:45:00.000Z",
          elapsedSeconds: 900,
          retryAfterAt: "2026-09-20T12:15:00.000Z"
        }
      ],
      completed: [
        {
          character: { region: "eu", realm: "silvermoon", name: "partial" },
          state: "partial",
          limitationCode: "request_cap",
          parseLimitationCode: "parse_request_cap",
          completedAt: "2026-09-20T11:00:00.000Z",
          evidenceVersion: 12
        }
      ],
      failed: [
        {
          character: { region: "eu", realm: "silvermoon", name: "failed" },
          errorCode: "warcraft_logs_unavailable",
          stoppedAt: "2026-09-20T09:30:00.000Z"
        }
      ]
    });
  });
});
