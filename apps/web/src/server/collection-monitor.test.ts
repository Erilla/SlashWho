import type { ApplicationConfig } from "@slashwho/application";
import type { EvidenceMonitorRun } from "@slashwho/database";
import { describe, expect, it } from "vitest";

import {
  createCollectionMonitorService,
  isOperatorRequest
} from "./collection-monitor";

const applicationConfig: ApplicationConfig = {
  BOT_API_KEY: "operator-secret-that-is-at-least-32-characters",
  RATE_LIMIT_HASH_SECRET: "rate-limit-secret-that-is-32-chars",
  ANONYMOUS_SEARCHES_PER_HOUR: 10,
  BOT_SEARCHES_PER_HOUR: 60,
  PUBLIC_READS_PER_MINUTE: 300,
  FRESHNESS_HOURS: 24,
  DOSSIER_CHARACTER_CAP: 12,
  DOSSIER_PROVIDER_CONCURRENCY: 4,
  NEGATIVE_CACHE_TTL_MS: 300_000
};

describe("operator collection monitor", () => {
  it("accepts only the existing bot Bearer credential", () => {
    expect(
      isOperatorRequest(
        new Headers({
          authorization: `Bearer ${applicationConfig.BOT_API_KEY}`
        }),
        applicationConfig
      )
    ).toBe(true);
    expect(
      isOperatorRequest(
        new Headers({ authorization: `Bearer ${"x".repeat(40)}` }),
        applicationConfig
      )
    ).toBe(false);
    expect(
      isOperatorRequest(
        new Headers({ "x-real-ip": "203.0.113.8" }),
        applicationConfig
      )
    ).toBe(false);
    expect(isOperatorRequest(new Headers(), applicationConfig)).toBe(false);
  });

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
