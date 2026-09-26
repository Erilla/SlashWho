import type { DiscoveryRun, EvidenceMonitorRun } from "@slashwho/database";
import { describe, expect, it } from "vitest";

import { createCollectionMonitorService } from "./collection-monitor";

const noDiscoveryRuns = {
  async listRecent() {
    return [];
  }
};

function discoveryRun(
  overrides: Partial<DiscoveryRun> & Pick<DiscoveryRun, "id" | "status">
): DiscoveryRun {
  return {
    rootKey: { region: "eu", realm: "silvermoon", name: overrides.id },
    rootCharacterId: null,
    queueJobId: null,
    callerClass: "anonymous",
    attempt: 0,
    nextRetryAt: null,
    errorCode: null,
    createdAt: new Date("2026-09-20T11:00:00Z"),
    startedAt: null,
    completedAt: null,
    snapshotId: null,
    ...overrides
  };
}

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
        completedAt: null,
        phases: []
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
        completedAt: null,
        phases: []
      },
      {
        key: { region: "eu", realm: "silvermoon", name: "running" },
        status: "running",
        evidenceVersion: 13,
        attempt: 1,
        limitationCode: null,
        parseLimitationCode: null,
        retryAfterAt: null,
        errorCode: null,
        startedAt: new Date("2026-09-20T11:50:00Z"),
        completedAt: null,
        phases: [
          {
            id: "warcraft_logs_history",
            state: "limited",
            limitationCode: "schema_drift"
          },
          {
            id: "warcraft_logs_fight_parses",
            state: "active",
            limitationCode: null
          },
          { id: "publication", state: "pending", limitationCode: null }
        ]
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
        completedAt: new Date("2026-09-20T11:00:00Z"),
        phases: []
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
        completedAt: new Date("2026-09-20T09:30:00Z"),
        phases: []
      }
    ];
    const service = createCollectionMonitorService({
      evidence: {
        async listForMonitor() {
          return rows;
        }
      },
      runs: noDiscoveryRuns,
      clock: () => new Date("2026-09-20T12:00:00Z")
    });

    await expect(service.list()).resolves.toEqual({
      generatedAt: "2026-09-20T12:00:00.000Z",
      hasActiveRuns: true,
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
        },
        {
          character: {
            region: "eu",
            realm: "silvermoon",
            name: "running"
          },
          status: "running",
          attempt: 1,
          startedAt: "2026-09-20T11:50:00.000Z",
          elapsedSeconds: 600,
          retryAfterAt: null,
          collectionProgress: [
            {
              id: "warcraft_logs_history",
              state: "limited",
              limitationCode: "schema_changed"
            },
            { id: "warcraft_logs_fight_parses", state: "active" },
            { id: "publication", state: "pending" }
          ]
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
      ],
      discoveryRuns: []
    });
  });

  it("reports no active runs when every row is terminal", async () => {
    const rows: EvidenceMonitorRun[] = [
      {
        key: { region: "eu", realm: "silvermoon", name: "complete" },
        status: "complete",
        evidenceVersion: 13,
        attempt: 1,
        limitationCode: null,
        parseLimitationCode: null,
        retryAfterAt: null,
        errorCode: null,
        startedAt: new Date("2026-09-20T09:00:00Z"),
        completedAt: new Date("2026-09-20T09:30:00Z"),
        phases: []
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
        completedAt: new Date("2026-09-20T11:00:00Z"),
        phases: []
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
        completedAt: new Date("2026-09-20T09:30:00Z"),
        phases: []
      }
    ];
    const service = createCollectionMonitorService({
      evidence: {
        async listForMonitor() {
          return rows;
        }
      },
      runs: noDiscoveryRuns,
      clock: () => new Date("2026-09-20T12:00:00Z")
    });

    await expect(service.list()).resolves.toMatchObject({
      hasActiveRuns: false
    });
  });

  it("lists recent discovery runs newest first without internal identifiers", async () => {
    const limits: number[] = [];
    const service = createCollectionMonitorService({
      evidence: {
        async listForMonitor() {
          return [];
        }
      },
      runs: {
        async listRecent(limit) {
          limits.push(limit);
          return [
            discoveryRun({
              id: "newest",
              status: "running",
              attempt: 1,
              queueJobId: "job-1",
              createdAt: new Date("2026-09-20T11:58:00Z"),
              startedAt: new Date("2026-09-20T11:59:00Z")
            }),
            discoveryRun({
              id: "older",
              status: "failed",
              attempt: 3,
              errorCode: "upstream_unavailable",
              createdAt: new Date("2026-09-20T11:00:00Z"),
              startedAt: new Date("2026-09-20T11:01:00Z"),
              completedAt: new Date("2026-09-20T11:05:00Z")
            }),
            discoveryRun({
              id: "oldest",
              status: "complete",
              attempt: 1,
              rootCharacterId: "character-1",
              snapshotId: "snapshot-1",
              createdAt: new Date("2026-09-20T10:00:00Z"),
              startedAt: new Date("2026-09-20T10:00:05Z"),
              completedAt: new Date("2026-09-20T10:00:30Z")
            })
          ];
        }
      },
      clock: () => new Date("2026-09-20T12:00:00Z")
    });

    const monitor = await service.list();

    expect(limits).toEqual([50]);
    expect(monitor.hasActiveRuns).toBe(true);
    expect(monitor.discoveryRuns).toEqual([
      {
        character: { region: "eu", realm: "silvermoon", name: "newest" },
        status: "running",
        attempt: 1,
        requestedAt: "2026-09-20T11:58:00.000Z",
        startedAt: "2026-09-20T11:59:00.000Z",
        completedAt: null,
        errorCode: null
      },
      {
        character: { region: "eu", realm: "silvermoon", name: "older" },
        status: "failed",
        attempt: 3,
        requestedAt: "2026-09-20T11:00:00.000Z",
        startedAt: "2026-09-20T11:01:00.000Z",
        completedAt: "2026-09-20T11:05:00.000Z",
        errorCode: "upstream_unavailable"
      },
      {
        character: { region: "eu", realm: "silvermoon", name: "oldest" },
        status: "complete",
        attempt: 1,
        requestedAt: "2026-09-20T10:00:00.000Z",
        startedAt: "2026-09-20T10:00:05.000Z",
        completedAt: "2026-09-20T10:00:30.000Z",
        errorCode: null
      }
    ]);
  });

  it("reports no active runs when every discovery run has settled", async () => {
    const service = createCollectionMonitorService({
      evidence: {
        async listForMonitor() {
          return [];
        }
      },
      runs: {
        async listRecent() {
          return [
            discoveryRun({ id: "complete", status: "complete" }),
            discoveryRun({ id: "failed", status: "failed" })
          ];
        }
      },
      clock: () => new Date("2026-09-20T12:00:00Z")
    });

    await expect(service.list()).resolves.toMatchObject({
      hasActiveRuns: false
    });
  });
});
