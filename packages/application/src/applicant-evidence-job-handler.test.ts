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

function store(activeRun: typeof run = run): ApplicantEvidenceStore & {
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

  it("builds a per-run gateway from encrypted run credentials when present", async () => {
    // Break caught: a visitor-supplied WCL credential could be ignored in
    // favor of the worker's own shared client, or leaked unencrypted.
    const perRunGateway = {
      getFirstKillReports: vi.fn().mockResolvedValue({
        kind: "evidence",
        kills: [],
        wipes: [],
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
      fail: vi.fn()
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

  it("passes the character's known class to the gateway", async () => {
    // Break caught: Warcraft Logs omits a class on its ranks, so without this
    // the four specialisation names shared by two classes resolve to no icon.
    const evidence = store({ ...run, className: "Death Knight" });
    const getFirstKillReports = vi.fn(async () => ({
      kind: "evidence" as const,
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
});
