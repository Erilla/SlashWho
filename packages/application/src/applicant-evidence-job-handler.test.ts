import type { WarcraftLogsGateway } from "@slashwho/warcraftlogs";
import { describe, expect, it, vi } from "vitest";

import {
  createApplicantEvidenceJobHandler,
  type ApplicantEvidenceStore
} from "./applicant-evidence-job-handler";
import { encryptCredential, parseEncryptionKey } from "./credential-encryption";

const encryptionKey = parseEncryptionKey("a".repeat(64));
const key = { region: "eu" as const, realm: "silvermoon", name: "rinn" };
const run = {
  id: "00000000-0000-4000-8000-000000000001",
  key,
  status: "queued" as const,
  createdAt: new Date("2026-09-13T12:00:00.000Z"),
  wclClientIdEncrypted: null,
  wclClientSecretEncrypted: null,
  className: null as string | null
};

function store(
  activeRun: typeof run = run,
  hydrated: readonly string[] = []
): ApplicantEvidenceStore & {
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
      return id === activeRun.id ? activeRun : null;
    },
    async claim(id) {
      return id === activeRun.id ? activeRun : null;
    },
    async publish(runId, result) {
      published.push({ runId, result });
    },
    async fail() {},
    async hydratedFightUrls() {
      return hydrated;
    }
  };
}

describe("applicant evidence job handler", () => {
  it("publishes the complete high-volume scan using the worker request cap", async () => {
    // Break caught: evidence collection could retain the short web timeout cap
    // and never reach current-tier reports for a prolific character.
    const evidence = store();
    const getFirstKillReports = vi.fn(async () => ({
      kind: "evidence" as const,
      tierBests: [],
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
      hydratedFightUrls: new Set(),
      signal: expect.any(AbortSignal)
    });
    expect(evidence.published).toEqual([
      {
        runId: run.id,
        result: {
          state: "complete",
          limitationCode: null,
          parseLimitationCode: null,
          tierBests: [],
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
          tierBests: [],
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
            tierBests: [],
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
          tierBests: [],
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

  it("builds a per-run gateway from encrypted run credentials when present", async () => {
    // Break caught: a visitor-supplied WCL credential could be ignored in
    // favor of the worker's own shared client, or leaked unencrypted.
    const perRunGateway = {
      getFirstKillReports: vi.fn().mockResolvedValue({
        kind: "evidence",
        kills: [],
        wipes: [],
        tierBests: [],
        limitation: null,
        parseLimitation: null
      })
    };
    const createWarcraftLogsGateway = vi.fn().mockReturnValue(perRunGateway);
    const evidence = {
      claim: vi.fn().mockResolvedValue({
        id: "run-1",
        key: { region: "eu", realm: "silvermoon", name: "Testcharacter" },
        status: "running",
        createdAt: new Date(),
        wclClientIdEncrypted: encryptCredential("user-id", encryptionKey),
        wclClientSecretEncrypted: encryptCredential(
          "user-secret",
          encryptionKey
        )
      }),
      publish: vi.fn().mockResolvedValue(undefined),
      find: vi.fn(),
      fail: vi.fn(),
      hydratedFightUrls: vi.fn().mockResolvedValue([])
    };
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs: { getFirstKillReports: vi.fn() }, // must NOT be called
      createWarcraftLogsGateway,
      decryptionKey: encryptionKey,
      requestCap: 80,
      parseRequestCap: 8
    });

    await handler.execute("run-1", {
      attempt: 1,
      maxAttempts: 1,
      signal: new AbortController().signal
    });

    expect(createWarcraftLogsGateway).toHaveBeenCalledWith({
      clientId: "user-id",
      clientSecret: "user-secret"
    });
    expect(perRunGateway.getFirstKillReports).toHaveBeenCalled();
  });

  it("tells the gateway which fights are already hydrated", async () => {
    // Break caught: without this the parse budget redid the same reports every
    // run, so coverage never advanced past whatever the first run reached.
    const evidence = store(run, [
      "https://www.warcraftlogs.com/reports/example#fight=1"
    ]);
    const getFirstKillReports = vi.fn(async () => ({
      kind: "evidence" as const,
      tierBests: [],
      kills: [],
      wipes: []
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

    expect(getFirstKillReports).toHaveBeenCalledWith(
      key,
      expect.objectContaining({
        hydratedFightUrls: new Set([
          "https://www.warcraftlogs.com/reports/example#fight=1"
        ])
      })
    );
  });

  it("reads only the most recent reports for a light refresh", async () => {
    // Break caught: a manual refresh inside its cooldown must still look for a
    // new raid night, but re-scanning a whole history would spend the same
    // rate-limited budget as a full collection.
    const evidence = store();
    const getFirstKillReports = vi.fn(async () => ({
      kind: "evidence" as const,
      tierBests: [],
      kills: [],
      wipes: []
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

    await handler.execute(
      { runId: run.id, mode: "light" },
      { attempt: 1, maxAttempts: 5, signal: new AbortController().signal }
    );

    expect(getFirstKillReports).toHaveBeenCalledWith(
      key,
      expect.objectContaining({ requestCap: 1 })
    );
  });

  it("passes the character's known class to the gateway", async () => {
    // Break caught: Warcraft Logs omits a class on its ranks, so without this
    // the four specialisation names shared by two classes resolve to no icon.
    const evidence = store({ ...run, className: "Death Knight" });
    const getFirstKillReports = vi.fn(async () => ({
      kind: "evidence" as const,
      tierBests: [],
      kills: [],
      wipes: []
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

    expect(getFirstKillReports).toHaveBeenCalledWith(
      key,
      expect.objectContaining({ className: "Death Knight" })
    );
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
        async hydratedFightUrls() {
          return [];
        },
        ...overrides
      };
    }

    function baseOptions() {
      return {
        evidence: evidenceStore(),
        warcraftLogs: {
          getFirstKillReports: async () => ({
            kind: "evidence" as const,
            tierBests: [],
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

    it("records a partial outcome exactly once", async () => {
      // Break caught: evidence gathered alongside a partial limitation could
      // be recorded with a stale "unknown" outcome, or emitted twice, if an
      // added early return or a duplicated logger call crept into this path.
      const records: Array<Record<string, unknown>> = [];
      const handler = createApplicantEvidenceJobHandler({
        ...baseOptions(),
        warcraftLogs: {
          getFirstKillReports: async () => ({
            kind: "evidence" as const,
            tierBests: [],
            limitation: {
              kind: "limitation" as const,
              code: "rate_limited" as const
            },
            parseLimitation: {
              kind: "limitation" as const,
              code: "parse_request_cap" as const
            },
            kills: [],
            wipes: []
          })
        },
        logger: { info: (record) => records.push(record) }
      });

      await handler.execute("run-5");

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        outcome: "partial",
        limitationCode: "rate_limited",
        parseLimitationCode: "parse_request_cap",
        killCount: 0
      });
    });

    it("records a cancelled outcome exactly once and still propagates the abort", async () => {
      // Break caught: an aborted run could be recorded with the wrong
      // outcome, emitted more than once, or have its abort silently
      // swallowed by the finally block, hiding cancellation from the queue.
      const records: Array<Record<string, unknown>> = [];
      const controller = new AbortController();
      controller.abort(new Error("aborted"));
      const handler = createApplicantEvidenceJobHandler({
        ...baseOptions(),
        logger: { info: (record) => records.push(record) }
      });

      await expect(
        handler.execute("run-6", {
          attempt: 1,
          maxAttempts: 3,
          signal: controller.signal
        })
      ).rejects.toThrow("aborted");

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ outcome: "cancelled" });
    });

    it("records an unexpected_error outcome exactly once and rethrows it unchanged", async () => {
      // Break caught: a failure while publishing could be recorded with the
      // wrong outcome, emitted more than once, or have the original error
      // swallowed or replaced, which would stop pg-boss from retrying it.
      const records: Array<Record<string, unknown>> = [];
      const failure = new Error("publish_failed");
      const handler = createApplicantEvidenceJobHandler({
        ...baseOptions(),
        evidence: evidenceStore({
          publish: async () => {
            throw failure;
          }
        }),
        logger: { info: (record) => records.push(record) }
      });

      await expect(handler.execute("run-7")).rejects.toBe(failure);

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ outcome: "unexpected_error" });
    });

    it("keeps a run's decrypted credentials out of the record entirely", async () => {
      // Break caught: the record is assembled beside the claimed run, so a
      // field spread from it — or a debugging aid left behind — could put a
      // visitor's Warcraft Logs secret into the worker's log stream. This is
      // the one place where an observability record and a user credential
      // meet, so it is asserted rather than assumed.
      const records: Array<Record<string, unknown>> = [];
      const handler = createApplicantEvidenceJobHandler({
        ...baseOptions(),
        evidence: evidenceStore({
          claim: async (id) => ({
            ...run,
            id,
            wclClientIdEncrypted: encryptCredential("user-id", encryptionKey),
            wclClientSecretEncrypted: encryptCredential(
              "user-secret",
              encryptionKey
            )
          })
        }),
        createWarcraftLogsGateway: () => ({
          getFirstKillReports: async () => ({
            kind: "evidence" as const,
            tierBests: [],
            kills: [],
            wipes: []
          })
        }),
        decryptionKey: encryptionKey,
        logger: { info: (record) => records.push(record) }
      });

      await handler.execute("run-8");

      expect(records).toHaveLength(1);
      const serialized = JSON.stringify(records[0]);
      expect(serialized).not.toContain("user-id");
      expect(serialized).not.toContain("user-secret");
      expect(serialized).not.toContain("wclClient");
    });
  });
});
