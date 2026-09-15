import type { WarcraftLogsGateway } from "@slashwho/warcraftlogs";
import { describe, expect, it, vi } from "vitest";

import {
  createApplicantEvidenceJobHandler,
  type ApplicantEvidenceStore
} from "./applicant-evidence-job-handler";

const key = { region: "eu" as const, realm: "silvermoon", name: "rinn" };
const run = {
  id: "00000000-0000-4000-8000-000000000001",
  key,
  status: "queued" as const,
  createdAt: new Date("2026-09-13T12:00:00.000Z")
};

function store(): ApplicantEvidenceStore & {
  published: Array<{
    runId: string;
    result: Parameters<ApplicantEvidenceStore["publish"]>[1];
  }>;
} {
  const published: Array<{
    runId: string;
    result: Parameters<ApplicantEvidenceStore["publish"]>[1];
  }> = [];
  return {
    published,
    async find(id) {
      return id === run.id ? run : null;
    },
    async claim(id) {
      return id === run.id ? run : null;
    },
    async publish(runId, result) {
      published.push({ runId, result });
    },
    async fail() {}
  };
}

describe("applicant evidence job handler", () => {
  it("publishes the complete high-volume scan using the worker request cap", async () => {
    // Break caught: evidence collection could retain the short web timeout cap
    // and never reach current-tier reports for a prolific character.
    const evidence = store();
    const getFirstKillReports = vi.fn(async () => ({
      kind: "evidence" as const,
      kills: [
        {
          raidId: "42",
          raidName: "Current Tier",
          bossId: "7",
          bossName: "Final Boss",
          journalBossId: "7",
          bossOrder: 7,
          isFinalBoss: false as const,
          killedAt: "2026-09-12T20:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/report",
          fightUrl: "https://www.warcraftlogs.com/reports/report#fight=7",
          guild: { name: "Guild", region: "eu", realm: "Silvermoon" },
          historicWorldRank: null,
          reportCode: "report",
          fightId: 7,
          difficulty: 5,
          performance: {
            damage: { state: "unavailable" as const },
            healing: { state: "unavailable" as const },
            bossDamage: { state: "unavailable" as const }
          }
        }
      ],
      wipes: [
        {
          raidId: "42",
          raidName: "Current Tier",
          bossId: "6",
          bossName: "Wiped Boss",
          journalBossId: "6",
          bossOrder: 6,
          attemptedAt: "2026-09-12T19:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/wipe",
          fightUrl: "https://www.warcraftlogs.com/reports/wipe#fight=6"
        }
      ]
    }));
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs: { getFirstKillReports } as Pick<
        WarcraftLogsGateway,
        "getFirstKillReports"
      >,
      requestCap: 500,
      parseRequestCap: 8,
      now: () => new Date("2026-09-13T12:01:00.000Z")
    });

    await handler.execute(run.id, {
      attempt: 1,
      maxAttempts: 5,
      signal: new AbortController().signal
    });

    expect(getFirstKillReports).toHaveBeenCalledWith(key, {
      requestCap: 500,
      parseRequestCap: 8,
      signal: expect.any(AbortSignal)
    });
    expect(evidence.published).toEqual([
      {
        runId: run.id,
        result: {
          state: "complete",
          limitationCode: null,
          parseLimitationCode: null,
          kills: [
            expect.objectContaining({
              bossName: "Final Boss",
              raidName: "Current Tier"
            })
          ],
          wipes: [
            expect.objectContaining({
              bossName: "Wiped Boss",
              raidName: "Current Tier"
            })
          ],
          completedAt: new Date("2026-09-13T12:01:00.000Z")
        }
      }
    ]);
  });

  it("publishes gathered kills as partial rather than deleting a prior result", async () => {
    // Break caught: a rate-limit response could erase the last complete scan
    // instead of retaining its evidence and honestly marking the new run partial.
    const evidence = store();
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs: {
        async getFirstKillReports() {
          return {
            kind: "limitation",
            code: "rate_limited",
            retryAfterMs: 90_000
          };
        }
      },
      requestCap: 500,
      parseRequestCap: 8,
      now: () => new Date("2026-09-13T12:01:00.000Z")
    });

    await handler.execute(run.id, {
      attempt: 1,
      maxAttempts: 5,
      signal: new AbortController().signal
    });

    expect(evidence.published).toEqual([
      {
        runId: run.id,
        result: {
          state: "partial",
          limitationCode: "rate_limited",
          parseLimitationCode: null,
          retryAfterAt: new Date("2026-09-13T12:02:30.000Z"),
          kills: [],
          wipes: [],
          completedAt: new Date("2026-09-13T12:01:00.000Z")
        }
      }
    ]);
  });

  it("passes normalized parses and parse limitations unchanged to publication", async () => {
    // Break caught: gateway-only ranking data could leak into persistence, or
    // a parse-specific partial limitation could be replaced by scan metadata.
    const evidence = store();
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs: {
        async getFirstKillReports() {
          return {
            kind: "evidence" as const,
            parseLimitation: {
              kind: "limitation" as const,
              code: "parse_request_cap" as const
            },
            kills: [
              {
                raidId: "42",
                raidName: "Current Tier",
                bossId: "7",
                bossName: "Final Boss",
                journalBossId: "7",
                bossOrder: 7,
                isFinalBoss: false as const,
                killedAt: "2026-09-12T20:00:00.000Z",
                reportCode: "report",
                fightId: 7,
                difficulty: 5,
                reportUrl: "https://www.warcraftlogs.com/reports/report",
                fightUrl: "https://www.warcraftlogs.com/reports/report#fight=7",
                guild: { name: "Guild", region: "eu", realm: "Silvermoon" },
                historicWorldRank: null,
                performance: {
                  damage: { state: "available" as const, percentile: 0 },
                  healing: { state: "not_applicable" as const },
                  bossDamage: { state: "unavailable" as const }
                }
              }
            ],
            wipes: []
          };
        }
      },
      requestCap: 500,
      parseRequestCap: 8,
      now: () => new Date("2026-09-13T12:01:00.000Z")
    });

    await handler.execute(run.id, {
      attempt: 1,
      maxAttempts: 5,
      signal: new AbortController().signal
    });

    expect(evidence.published).toEqual([
      {
        runId: run.id,
        result: {
          state: "complete",
          limitationCode: null,
          parseLimitationCode: "parse_request_cap",
          kills: [
            {
              raidId: "42",
              raidName: "Current Tier",
              bossId: "7",
              bossName: "Final Boss",
              journalBossId: "7",
              bossOrder: 7,
              isFinalBoss: false,
              killedAt: "2026-09-12T20:00:00.000Z",
              reportUrl: "https://www.warcraftlogs.com/reports/report",
              fightUrl: "https://www.warcraftlogs.com/reports/report#fight=7",
              guild: { name: "Guild", region: "eu", realm: "Silvermoon" },
              historicWorldRank: null,
              performance: {
                damage: { state: "available", percentile: 0 },
                healing: { state: "not_applicable" },
                bossDamage: { state: "unavailable" }
              }
            }
          ],
          wipes: [],
          completedAt: new Date("2026-09-13T12:01:00.000Z")
        }
      }
    ]);
  });

  describe("evidence_job record", () => {
    // Fixtures local to this describe block: the brief's tests exercise
    // runIds ("run-1".."run-4") that the module-level `run`/`store()` fixture
    // above does not recognize, so claim() here accepts any runId.
    function evidenceStore(
      overrides: Partial<ApplicantEvidenceStore> = {}
    ): ApplicantEvidenceStore {
      return {
        async find(id) {
          return id === run.id ? run : null;
        },
        async claim(id) {
          return { ...run, id };
        },
        async publish() {},
        async fail() {},
        ...overrides
      };
    }

    function baseOptions() {
      return {
        evidence: evidenceStore(),
        warcraftLogs: {
          getFirstKillReports: async () => ({
            kind: "evidence" as const,
            kills: [],
            wipes: []
          })
        },
        requestCap: 500,
        parseRequestCap: 8
      };
    }

    it("emits one evidence_job record per run", async () => {
      // Break caught: the evidence job could run without ever recording its
      // duration, outcome, or queue wait, leaving it invisible in production.
      const records: Array<Record<string, unknown>> = [];
      const handler = createApplicantEvidenceJobHandler({
        ...baseOptions(),
        logger: { info: (record) => records.push(record) },
        monotonic: (() => {
          let index = 0;
          const steps = [0, 50, 50, 50];
          return () => steps[Math.min(index++, steps.length - 1)]!;
        })()
      });

      await handler.execute(
        {
          runId: "run-1",
          correlationId: "c1",
          enqueuedAt: new Date(Date.now() - 2_000).toISOString()
        },
        { attempt: 1, maxAttempts: 3, signal: new AbortController().signal }
      );

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        event: "evidence_job",
        runId: "run-1",
        correlationId: "c1",
        outcome: "complete",
        warcraftLogsCalls: 1
      });
      expect(records[0]!.queueWaitMs).toBeGreaterThanOrEqual(1_900);
    });

    it("records a limitation outcome", async () => {
      // Break caught: a rate-limited run could be recorded with no way to
      // tell it apart from a successful one.
      const records: Array<Record<string, unknown>> = [];
      const handler = createApplicantEvidenceJobHandler({
        ...baseOptions(),
        warcraftLogs: {
          getFirstKillReports: async () => ({
            kind: "limitation" as const,
            code: "rate_limited" as const
          })
        },
        logger: { info: (record) => records.push(record) }
      });

      await handler.execute("run-2");

      expect(records[0]).toMatchObject({
        outcome: "limitation",
        limitationCode: "rate_limited"
      });
    });

    it("records a run that was never claimed", async () => {
      // Break caught: a run another worker already claimed could disappear
      // from observability instead of being recorded as skipped.
      const records: Array<Record<string, unknown>> = [];
      const handler = createApplicantEvidenceJobHandler({
        ...baseOptions(),
        evidence: evidenceStore({ claim: async () => null }),
        logger: { info: (record) => records.push(record) }
      });

      await handler.execute("run-3");

      expect(records[0]).toMatchObject({ outcome: "not_claimed" });
    });

    it("emits nothing when no logger is supplied", async () => {
      // Break caught: adding the record could accidentally require a logger,
      // breaking existing callers that construct the handler without one.
      const handler = createApplicantEvidenceJobHandler(baseOptions());
      await expect(handler.execute("run-4")).resolves.toBeUndefined();
    });
  });
});
