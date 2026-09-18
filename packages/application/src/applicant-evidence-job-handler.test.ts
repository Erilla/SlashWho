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

// Keeps the admission gate open for every test that is not about the budget:
// the handler now reads the allowance before it collects anything.
const openGate = {
  getRateLimit: async () => ({
    kind: "rate_limit" as const,
    limitPerHour: 18_000,
    pointsSpentThisHour: 0,
    pointsResetInSeconds: 949
  })
};

function store(
  activeRun: typeof run = run,
  hydrated: readonly string[] = []
): ApplicantEvidenceStore & {
  published: Array<{
    runId: string;
    result: Parameters<ApplicantEvidenceStore["publish"]>[1];
  }>;
  failed: Array<{ runId: string; code: string }>;
  noted: Array<{ runId: string; code: string }>;
} {
  const published: Array<{
    runId: string;
    result: Parameters<ApplicantEvidenceStore["publish"]>[1];
  }> = [];
  const failed: Array<{ runId: string; code: string }> = [];
  const noted: Array<{ runId: string; code: string }> = [];
  return {
    published,
    failed,
    noted,
    async find(id) {
      return id === activeRun.id ? activeRun : null;
    },
    async claim(id) {
      return id === activeRun.id ? activeRun : null;
    },
    async publish(runId, result) {
      published.push({ runId, result });
    },
    async fail(runId, code) {
      failed.push({ runId, code });
    },
    async recordLimitation(runId, code) {
      noted.push({ runId, code });
    },
    async collectedTierZones() {
      return [];
    },
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
      troubledRaidIds: [],
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
      warcraftLogs: { ...openGate, getFirstKillReports } as Pick<
        WarcraftLogsGateway,
        "getFirstKillReports" | "getRateLimit"
      >,
      requestCap: 500,
      parseRequestCap: 8,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500,
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
      collectedTierZones: new Map(),
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
        ...openGate,
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
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500,
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
        ...openGate,
        async getFirstKillReports() {
          return {
            kind: "evidence" as const,
            troubledRaidIds: [],
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
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500,
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
          // A run that spent its whole parse budget did not finish, and says
          // so -- and carries the retry that brings it back, because a cap is
          // our own budget rather than an upstream 429 and has no retry hint
          // of its own to pass on.
          state: "partial",
          limitationCode: null,
          parseLimitationCode: "parse_request_cap",
          retryAfterAt: new Date("2026-09-13T12:31:00.000Z"),
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
      ...openGate,
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
      recordLimitation: vi.fn(),
      hydratedFightUrls: vi.fn().mockResolvedValue([]),
      collectedTierZones: vi.fn().mockResolvedValue([])
    };
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs: { ...openGate, getFirstKillReports: vi.fn() }, // must NOT be called
      createWarcraftLogsGateway,
      decryptionKey: encryptionKey,
      requestCap: 80,
      parseRequestCap: 8,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500
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
      troubledRaidIds: [],
      tierBests: [],
      kills: [],
      wipes: []
    }));
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs: { ...openGate, getFirstKillReports } as Pick<
        WarcraftLogsGateway,
        "getFirstKillReports" | "getRateLimit"
      >,
      requestCap: 500,
      parseRequestCap: 8,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500,
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
      troubledRaidIds: [],
      tierBests: [],
      kills: [],
      wipes: []
    }));
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs: { ...openGate, getFirstKillReports } as Pick<
        WarcraftLogsGateway,
        "getFirstKillReports" | "getRateLimit"
      >,
      requestCap: 500,
      parseRequestCap: 8,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500,
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
      troubledRaidIds: [],
      tierBests: [],
      kills: [],
      wipes: []
    }));
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs: { ...openGate, getFirstKillReports } as Pick<
        WarcraftLogsGateway,
        "getFirstKillReports" | "getRateLimit"
      >,
      requestCap: 500,
      parseRequestCap: 8,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500,
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

  function budgetGateway(
    rateLimit: Awaited<ReturnType<WarcraftLogsGateway["getRateLimit"]>>,
    getFirstKillReports = vi.fn(async () => ({
      kind: "evidence" as const,
      troubledRaidIds: [],
      kills: [],
      wipes: [],
      tierBests: []
    }))
  ) {
    return {
      getRateLimit: vi.fn(async () => rateLimit),
      getFirstKillReports
    } as unknown as Pick<
      WarcraftLogsGateway,
      "getFirstKillReports" | "getRateLimit"
    > & { getRateLimit: ReturnType<typeof vi.fn> };
  }

  it("refuses to start when too little of the hourly allowance remains", async () => {
    // Break caught: ten runs started against an exhausted allowance on
    // 2026-09-17, were all rate limited within six minutes, and gained nothing.
    const evidence = store();
    const warcraftLogs = budgetGateway({
      kind: "rate_limit",
      limitPerHour: 18_000,
      pointsSpentThisHour: 17_500.5,
      pointsResetInSeconds: 949
    });
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs,
      requestCap: 500,
      parseRequestCap: 24,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500
    });

    await expect(
      handler.execute(run.id, {
        attempt: 1,
        maxAttempts: 5,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 949_000
    });
    expect(warcraftLogs.getFirstKillReports).not.toHaveBeenCalled();
    // Nothing published: a zero-kill publish risks the destructive merge of #250.
    expect(evidence.published).toEqual([]);
  });

  it("clamps a refusal's retry past the queue's maximum delay", async () => {
    // Break caught: requestedRetryDelaySeconds returns null above 1800, the job
    // falls back to retryDelay 1 with backoff, and retries straight into another
    // refusal. pointsResetIn reaches 3600.
    const handler = createApplicantEvidenceJobHandler({
      evidence: store(),
      warcraftLogs: budgetGateway({
        kind: "rate_limit",
        limitPerHour: 18_000,
        pointsSpentThisHour: 17_999,
        pointsResetInSeconds: 3_600
      }),
      requestCap: 500,
      parseRequestCap: 24,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500
    });

    await expect(
      handler.execute(run.id, {
        attempt: 1,
        maxAttempts: 5,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 1_800_000
    });
  });

  it("records the refusal on the run so a reader can be told why", async () => {
    // Break caught: the refusal publishes nothing, so the dossier read only the
    // completed run and the deferral copy was unreachable. A reader saw an
    // unexplained "collecting" state for as long as the allowance stayed spent.
    const evidence = store();
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs: budgetGateway({
        kind: "rate_limit",
        limitPerHour: 18_000,
        pointsSpentThisHour: 17_500.5,
        pointsResetInSeconds: 949
      }),
      requestCap: 500,
      parseRequestCap: 24,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500
    });

    await expect(
      handler.execute(run.id, {
        attempt: 1,
        maxAttempts: 5,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("evidence_points_budget_low");

    expect(evidence.noted).toEqual([
      { runId: run.id, code: "points_budget_low" }
    ]);
  });

  it("fails a run whose refusal exhausts the last attempt", async () => {
    // Break caught: nothing called the evidence store's fail, so a run that
    // refused on every attempt stayed `running` once pg-boss gave up. `reserve`
    // counts ('queued','running','retrying') as active with no staleness
    // cutoff, so that character could never be collected again.
    const evidence = store();
    const warcraftLogs = budgetGateway({
      kind: "rate_limit",
      limitPerHour: 18_000,
      pointsSpentThisHour: 17_500.5,
      pointsResetInSeconds: 949
    });
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs,
      requestCap: 500,
      parseRequestCap: 24,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500
    });

    await expect(
      handler.execute(run.id, {
        attempt: 5,
        maxAttempts: 5,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("evidence_points_budget_low");

    expect(evidence.failed).toEqual([
      { runId: run.id, code: "points_budget_low" }
    ]);
    expect(evidence.published).toEqual([]);
  });

  it("asks for no retry it cannot have on the last attempt", async () => {
    // Break caught: a retryable error on the final attempt sends the queue to
    // updateActiveRetryDelay, whose `AND state = 'active'` matches no row once
    // the job is failing. It throws, replacing the refusal, and the real cause
    // is lost from the logs.
    const handler = createApplicantEvidenceJobHandler({
      evidence: store(),
      warcraftLogs: budgetGateway({
        kind: "rate_limit",
        limitPerHour: 18_000,
        pointsSpentThisHour: 17_500.5,
        pointsResetInSeconds: 949
      }),
      requestCap: 500,
      parseRequestCap: 24,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500
    });

    const error = await handler
      .execute(run.id, {
        attempt: 5,
        maxAttempts: 5,
        signal: new AbortController().signal
      })
      .catch((thrown: unknown) => thrown);

    expect(error).not.toHaveProperty("retryable");
    expect(error).not.toHaveProperty("retryAfterMs");
  });

  it("collects when the allowance is healthy", async () => {
    // Break caught: an off-by-one or inverted comparison would refuse every run
    // and stop collection entirely.
    const evidence = store();
    const warcraftLogs = budgetGateway({
      kind: "rate_limit",
      limitPerHour: 18_000,
      pointsSpentThisHour: 1_000.25,
      pointsResetInSeconds: 949
    });
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs,
      requestCap: 500,
      parseRequestCap: 24,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500
    });

    await handler.execute(run.id);

    expect(warcraftLogs.getFirstKillReports).toHaveBeenCalledOnce();
    expect(evidence.published).toHaveLength(1);
  });

  it("scales the reserve down to a smaller account's allowance", async () => {
    // Break caught: the reserve is an absolute count applied to whichever
    // account the run carries. A visitor's default allowance is 3600 against
    // the worker's 18000, so a flat 1500 fences off 42% of their budget and
    // refuses runs the account could comfortably afford.
    const evidence = store();
    const warcraftLogs = budgetGateway({
      kind: "rate_limit",
      limitPerHour: 3_600,
      pointsSpentThisHour: 2_600,
      pointsResetInSeconds: 949
    });
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs,
      requestCap: 500,
      parseRequestCap: 24,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500
    });

    await handler.execute(run.id);

    expect(warcraftLogs.getFirstKillReports).toHaveBeenCalledOnce();
    expect(evidence.published).toHaveLength(1);
  });

  it("still refuses a small account with almost nothing left", async () => {
    // Break caught: scaling the reserve to the allowance must not amount to
    // removing the gate for accounts that need it most.
    const evidence = store();
    const warcraftLogs = budgetGateway({
      kind: "rate_limit",
      limitPerHour: 3_600,
      pointsSpentThisHour: 3_400,
      pointsResetInSeconds: 949
    });
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs,
      requestCap: 500,
      parseRequestCap: 24,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500
    });

    await expect(
      handler.execute(run.id, {
        attempt: 1,
        maxAttempts: 5,
        signal: new AbortController().signal
      })
    ).rejects.toThrow("evidence_points_budget_low");
    expect(warcraftLogs.getFirstKillReports).not.toHaveBeenCalled();
  });

  it("collects with the gate switched off, even past the allowance", async () => {
    // Break caught: a reserve of 0 is the operator's off switch for a policy
    // the code itself calls a guess. Reading it as "refuse whenever nothing
    // remains" would keep gating exactly when it was asked to stop -- spend
    // overruns the limit, 9058.65 against 9000 was observed.
    const evidence = store();
    const warcraftLogs = budgetGateway({
      kind: "rate_limit",
      limitPerHour: 18_000,
      pointsSpentThisHour: 18_058.65,
      pointsResetInSeconds: 949
    });
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs,
      requestCap: 500,
      parseRequestCap: 24,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 0
    });

    await handler.execute(run.id);

    expect(warcraftLogs.getFirstKillReports).toHaveBeenCalledOnce();
    expect(evidence.published).toHaveLength(1);
  });

  it("publishes what it collected when the closing measurement fails", async () => {
    // Break caught: the closing sample is an extra round trip between a
    // finished collection and its publish. The gateway rethrows the abort
    // reason, so a graceful shutdown landing in that window discarded a run
    // that had already spent its whole request and parse budget.
    const evidence = store();
    const getRateLimit = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "rate_limit",
        limitPerHour: 18_000,
        pointsSpentThisHour: 1_000.25,
        pointsResetInSeconds: 949
      })
      .mockRejectedValueOnce(new Error("aborted"));
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs: {
        getRateLimit,
        getFirstKillReports: vi.fn(async () => ({
          kind: "evidence" as const,
          troubledRaidIds: [],
          kills: [],
          wipes: [],
          tierBests: []
        }))
      } as unknown as Pick<
        WarcraftLogsGateway,
        "getFirstKillReports" | "getRateLimit"
      >,
      requestCap: 500,
      parseRequestCap: 24,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500
    });

    await handler.execute(run.id);

    expect(evidence.published).toHaveLength(1);
  });

  it("collects when the allowance itself cannot be read", async () => {
    // Break caught: a gate that fails closed on its own transport errors can
    // stop all evidence collection permanently.
    const evidence = store();
    const warcraftLogs = budgetGateway({
      kind: "limitation",
      code: "unavailable"
    });
    const handler = createApplicantEvidenceJobHandler({
      evidence,
      warcraftLogs,
      requestCap: 500,
      parseRequestCap: 24,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500
    });

    await handler.execute(run.id);

    expect(warcraftLogs.getFirstKillReports).toHaveBeenCalledOnce();
    expect(evidence.published).toHaveLength(1);
  });

  it("logs what the run spent against the allowance", async () => {
    // Break caught: the 1500 reserve is an admitted guess, and without a measured
    // per-run spend there is nothing to replace it with.
    const infos: Array<Record<string, unknown>> = [];
    const getRateLimit = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "rate_limit",
        limitPerHour: 18_000,
        pointsSpentThisHour: 1_000.25,
        pointsResetInSeconds: 949
      })
      .mockResolvedValueOnce({
        kind: "rate_limit",
        limitPerHour: 18_000,
        pointsSpentThisHour: 1_950.75,
        pointsResetInSeconds: 900
      });
    const handler = createApplicantEvidenceJobHandler({
      evidence: store(),
      warcraftLogs: {
        getRateLimit,
        getFirstKillReports: vi.fn(async () => ({
          kind: "evidence" as const,
          troubledRaidIds: [],
          kills: [],
          wipes: [],
          tierBests: []
        }))
      } as unknown as Pick<
        WarcraftLogsGateway,
        "getFirstKillReports" | "getRateLimit"
      >,
      requestCap: 500,
      parseRequestCap: 24,
      parseCapRetryMs: 1_800_000,
      pointsReserve: 1_500,
      logger: { info: (value) => infos.push(value) }
    });

    await handler.execute(run.id);

    expect(infos.at(-1)).toMatchObject({
      pointsLimitPerHour: 18_000,
      pointsRemainingBefore: 16_999.75,
      pointsSpentByRun: 950.5,
      pointsRemainingAfter: 16_049.25
    });
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
        async recordLimitation() {},
        async collectedTierZones() {
          return [];
        },
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
          ...openGate,
          getFirstKillReports: async () => ({
            kind: "evidence" as const,
            troubledRaidIds: [],
            tierBests: [],
            kills: [],
            wipes: []
          })
        },
        requestCap: 500,
        parseRequestCap: 8,
        parseCapRetryMs: 1_800_000,
        pointsReserve: 1_500
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
          ...openGate,
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
          ...openGate,
          getFirstKillReports: async () => ({
            kind: "evidence" as const,
            troubledRaidIds: [],
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

    it("names the cause of an unexpected error on the record", async () => {
      // Break caught: `unexpected_error` on its own is not a cause. Eleven
      // runs failed after spending an hour's allowance (#290) and the reason
      // was nowhere in the logs, because the record named the outcome and
      // nothing else.
      const records: Array<Record<string, unknown>> = [];
      const handler = createApplicantEvidenceJobHandler({
        ...baseOptions(),
        evidence: evidenceStore({
          publish: async () => {
            throw new RangeError("character_evidence_publication_invalid");
          }
        }),
        logger: { info: (record) => records.push(record) }
      });

      await expect(handler.execute("run-7a")).rejects.toThrow(
        "character_evidence_publication_invalid"
      );

      expect(records[0]).toMatchObject({
        outcome: "unexpected_error",
        errorName: "RangeError",
        errorCode: "character_evidence_publication_invalid"
      });
    });

    it("keeps a message that is not a code out of the record", async () => {
      // Break caught: an error message is unbounded text and can carry a
      // character name, a realm, a URL or an upstream payload. Only a
      // code-authored identifier -- a snake_case literal or a SQLSTATE --
      // is allowed through; anything else is reported by class alone.
      const records: Array<Record<string, unknown>> = [];
      const handler = createApplicantEvidenceJobHandler({
        ...baseOptions(),
        evidence: evidenceStore({
          publish: async () => {
            throw new Error(
              'duplicate key value violates unique constraint: "Ryii-Twisting Nether"'
            );
          }
        }),
        logger: { info: (record) => records.push(record) }
      });

      await expect(handler.execute("run-7b")).rejects.toThrow();

      expect(records[0]).toMatchObject({
        outcome: "unexpected_error",
        errorName: "Error",
        errorCode: null
      });
      expect(JSON.stringify(records[0])).not.toContain("Ryii");
    });

    it("prefers a driver's own error code to the message", async () => {
      // Break caught: a Postgres error carries its cause as a SQLSTATE and a
      // message that quotes the offending row. `23514` is the check-constraint
      // violation that would name a publication the database refused.
      const records: Array<Record<string, unknown>> = [];
      const handler = createApplicantEvidenceJobHandler({
        ...baseOptions(),
        evidence: evidenceStore({
          publish: async () => {
            throw Object.assign(
              new Error('new row for relation "character_evidence_runs" ...'),
              { code: "23514" }
            );
          }
        }),
        logger: { info: (record) => records.push(record) }
      });

      await expect(handler.execute("run-7c")).rejects.toThrow();

      expect(records[0]).toMatchObject({
        outcome: "unexpected_error",
        errorCode: "23514"
      });
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
          ...openGate,
          getFirstKillReports: async () => ({
            kind: "evidence" as const,
            troubledRaidIds: [],
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
  describe("evidence run announcements", () => {
    function announcingStore(
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
        async recordLimitation() {},
        async collectedTierZones() {
          return [];
        },
        async hydratedFightUrls() {
          return [];
        },
        ...overrides
      };
    }

    function announcingOptions() {
      return {
        evidence: announcingStore(),
        warcraftLogs: {
          ...openGate,
          getFirstKillReports: async () => ({
            kind: "evidence" as const,
            troubledRaidIds: [],
            tierBests: [],
            kills: [],
            wipes: []
          })
        },
        requestCap: 500,
        parseRequestCap: 8,
        parseCapRetryMs: 1_800_000,
        pointsReserve: 1_500
      };
    }

    function recordingNotifier() {
      const started: Array<Record<string, unknown>> = [];
      const finished: Array<Record<string, unknown>> = [];
      return {
        started,
        finished,
        notifier: {
          started: (value: Record<string, unknown>) => {
            started.push(value);
          },
          finished: (value: Record<string, unknown>) => {
            finished.push(value);
          }
        }
      };
    }

    it("announces the run against the claimed character once it is owned", async () => {
      // Break caught: announcing before `claim` would post for a run this
      // worker does not own, and would have no character key to name.
      const notifier = recordingNotifier();
      const handler = createApplicantEvidenceJobHandler({
        ...announcingOptions(),
        evidenceRunNotifier: notifier.notifier
      });

      await handler.execute("run-1", {
        attempt: 2,
        maxAttempts: 3,
        signal: new AbortController().signal
      });

      expect(notifier.started).toEqual([
        {
          runId: "run-1",
          region: "eu",
          realm: "silvermoon",
          name: "rinn",
          attempt: 2
        }
      ]);
    });

    it("announces the outcome the record reports", async () => {
      // Break caught: the announcement could drift from the logged outcome,
      // so a watcher sees success while the record says the run was limited.
      const notifier = recordingNotifier();
      const handler = createApplicantEvidenceJobHandler({
        ...announcingOptions(),
        warcraftLogs: {
          ...openGate,
          getFirstKillReports: async () => ({
            kind: "limitation" as const,
            code: "rate_limited" as const
          })
        },
        evidenceRunNotifier: notifier.notifier
      });

      await handler.execute("run-2");

      expect(notifier.finished).toHaveLength(1);
      expect(notifier.finished[0]).toMatchObject({
        runId: "run-2",
        region: "eu",
        realm: "silvermoon",
        name: "rinn",
        attempt: 1,
        outcome: "limitation",
        limitationCode: "rate_limited",
        parseLimitationCode: null
      });
    });

    it("carries the points the run spent when the allowance was readable", async () => {
      // Break caught: the whole point of #288's evening case is seeing the
      // allowance drain, so a run that spent points must say how many.
      const notifier = recordingNotifier();
      let call = 0;
      const handler = createApplicantEvidenceJobHandler({
        ...announcingOptions(),
        warcraftLogs: {
          getRateLimit: async () => ({
            kind: "rate_limit" as const,
            limitPerHour: 18_000,
            pointsSpentThisHour: call++ === 0 ? 1_000 : 3_400,
            pointsResetInSeconds: 949
          }),
          getFirstKillReports: async () => ({
            kind: "evidence" as const,
            troubledRaidIds: [],
            tierBests: [],
            kills: [],
            wipes: []
          })
        },
        evidenceRunNotifier: notifier.notifier
      });

      await handler.execute("run-3");

      expect(notifier.finished[0]).toMatchObject({
        outcome: "complete",
        pointsSpent: 2_400
      });
    });

    it("stays silent about a run it never claimed", async () => {
      // Break caught: a run another worker owns would be announced twice —
      // once by each worker — and this one has no character key to name.
      const notifier = recordingNotifier();
      const handler = createApplicantEvidenceJobHandler({
        ...announcingOptions(),
        evidence: announcingStore({ claim: async () => null }),
        evidenceRunNotifier: notifier.notifier
      });

      await handler.execute("run-4");

      expect(notifier.started).toEqual([]);
      expect(notifier.finished).toEqual([]);
    });

    it("completes the run when the notifier throws", async () => {
      // Break caught: the seam is public, so a chat outage must not fail or
      // stall evidence collection. Resilience belongs at the call site.
      const published: Array<unknown> = [];
      const records: Array<Record<string, unknown>> = [];
      const handler = createApplicantEvidenceJobHandler({
        ...announcingOptions(),
        evidence: announcingStore({
          async publish(_runId, result) {
            published.push(result);
          }
        }),
        evidenceRunNotifier: {
          started: () => {
            throw new Error("webhook down");
          },
          finished: () => {
            throw new Error("webhook down");
          }
        },
        logger: { info: (record) => records.push(record) }
      });

      await expect(handler.execute("run-5")).resolves.toBeUndefined();

      expect(published).toHaveLength(1);
      expect(
        records.filter(
          (entry) => entry.event === "evidence_run_announcement_failed"
        )
      ).toHaveLength(2);
    });
  });
});
