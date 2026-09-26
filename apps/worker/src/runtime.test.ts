import {
  encryptAccountMail,
  encryptCredential,
  upstreamThrottleRecord
} from "@slashwho/application";
import { hkdfSync } from "node:crypto";
import type {
  ApplicantEvidenceJobHandler,
  ApplicantEvidenceJobHandlerOptions,
  DiscoveryJobHandler,
  DiscoveryJobHandlerOptions,
  EvidenceRunNotifier
} from "@slashwho/application";
import { DiscoveryQueueStopTimeoutError } from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";
import type {
  DiscoverCharacterJob,
  DiscoveryQueue,
  DiscoveryWorkContext,
  Repositories,
  StagedEvidenceCollection
} from "@slashwho/database";
import type { RaiderIoGateway } from "@slashwho/raiderio";
import type { WarcraftLogsGateway } from "@slashwho/warcraftlogs";
import { describe, expect, it, vi } from "vitest";

import { drainApplicantIntents, pollApplicantSheet } from "./applicant-watcher";
import type { WorkerConfig } from "./config";
import {
  createDiscoveryRunNotifier,
  createEvidenceRunNotifier,
  createFingerprintAlertNotifier,
  createFingerprintIntegration,
  createRaiderIoGateway,
  createWorkerRuntime,
  createAccountWarcraftLogsResolver,
  announceNewApplicantIntents
} from "./runtime";

// The applicant watcher builds its Sheet client itself rather than taking it
// as a dependency, so the tests that switch the watcher on stub the client and
// the poll and drain it feeds. Every other test leaves the watcher disabled,
// where none of these is ever reached.
vi.mock("./applicant-sheet", () => ({
  createApplicantSheetClient: vi.fn(() => ({ readRows: vi.fn(async () => []) }))
}));
vi.mock("./applicant-watcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./applicant-watcher")>()),
  pollApplicantSheet: vi.fn(),
  drainApplicantIntents: vi.fn()
}));

it("announces newly recorded applicant intents without alerting on baseline or unchanged polls", async () => {
  const notify = vi.fn(async () => undefined);
  const notifier = { notify };

  await announceNewApplicantIntents({ baseline: true, created: 2 }, notifier);
  await announceNewApplicantIntents({ baseline: false, created: 0 }, notifier);
  await announceNewApplicantIntents({ baseline: false, created: 2 }, notifier);

  expect(notify).toHaveBeenCalledExactlyOnceWith({
    event: "applicant_new_intents",
    details: { count: 2 }
  });
});

it("announces applicant details with both the character and dossier links", async () => {
  const notify = vi.fn(async () => undefined);
  await announceNewApplicantIntents(
    {
      baseline: false,
      created: 1,
      newApplicants: [
        {
          battletag: "Aria#123",
          discordId: "123456789012345678",
          characterName: "Aria",
          characterUrl: "https://raider.io/characters/eu/example/aria",
          dossierPath: "/dossiers/eu/example/aria"
        }
      ]
    },
    { notify },
    undefined,
    "https://web-test.example.test"
  );
  expect(notify).toHaveBeenCalledExactlyOnceWith({
    event: "applicant_new_intents",
    details: { count: 1 },
    applicant: {
      battletag: "Aria#123",
      discordId: "123456789012345678",
      characterName: "Aria",
      characterUrl: "https://raider.io/characters/eu/example/aria",
      dossierUrl: "https://web-test.example.test/dossiers/eu/example/aria"
    }
  });
});

it("does not let an applicant alert failure interrupt intake", async () => {
  const notify = vi.fn(async () => {
    throw new Error("webhook unavailable");
  });

  await expect(
    announceNewApplicantIntents({ baseline: false, created: 1 }, { notify })
  ).resolves.toBeUndefined();
  expect(notify).toHaveBeenCalledOnce();
});

it("continues notifying later applicants when one delivery throws", async () => {
  const received: string[] = [];
  const notify = vi.fn(
    async (alert: { applicant?: { battletag?: string } }) => {
      received.push(alert.applicant?.battletag ?? "");
      if (received.length === 1) throw new Error("webhook unavailable");
    }
  );
  const logger = { info: vi.fn() };
  await announceNewApplicantIntents(
    {
      baseline: false,
      created: 2,
      newApplicants: [
        {
          battletag: "First#111",
          characterUrl: "https://raider.io/characters/eu/example/first"
        },
        {
          battletag: "Second#222",
          characterUrl: "https://raider.io/characters/eu/example/second"
        }
      ]
    },
    { notify },
    logger
  );
  expect(received).toEqual(["First#111", "Second#222"]);
  expect(logger.info).toHaveBeenCalledWith({
    event: "applicant_announcement_failed"
  });
});

it("resolves the worker account key only while active and at the reserved version", async () => {
  const masterKey = Buffer.alloc(32, 7);
  const key = Buffer.from(
    hkdfSync("sha256", masterKey, "", "account-provider-credentials-v1", 32)
  );
  let row: { encryptedPayload: string; version: number } | null = {
    encryptedPayload: encryptCredential(
      JSON.stringify({ clientId: "alice-id", clientSecret: "alice-key" }),
      key
    ),
    version: 1
  };
  const get = vi.fn(async () => row);
  const resolve = createAccountWarcraftLogsResolver({ get }, masterKey);
  expect(await resolve("alice", 1)).toEqual({
    values: { clientId: "alice-id", clientSecret: "alice-key" },
    version: 1
  });
  row = { ...row, version: 2 };
  expect(await resolve("alice", 1)).toBeNull();
  row = null;
  expect(await resolve("alice", 1)).toBeNull();
  expect(get).toHaveBeenCalledWith("alice", "warcraftlogs");
});

const config: WorkerConfig = {
  applicantWatcher: {
    enabled: false,
    column: "F",
    cadenceMs: 300_000,
    perTick: 1,
    perDay: 5,
    backlog: 100,
    queueDepth: 10,
    minimumPoints: 3500
  },
  databaseUrl: "postgres://worker:secret@database/slashwho",
  healthHost: "127.0.0.1",
  port: 3001,
  workerDrainTimeoutMs: 12_345,
  workerAbortGraceMs: 5_000,
  databaseStartupAttempts: 3,
  databaseStartupRetryMs: 10,
  discoveryRequestCap: 12,
  negativeCacheTtlMs: 300_000,
  raiderIoBaseUrl: "https://raider.io",
  raiderIoTimeoutMs: 5_000,
  blizzardClientId: "worker-client-id",
  blizzardClientSecret: "worker-client-secret",
  warcraftLogsClientId: "warcraft-logs-client-id",
  warcraftLogsClientSecret: "warcraft-logs-client-secret",
  evidenceRequestCap: 500,
  evidenceCapRetryMs: 1_800_000,
  evidenceTransientRetryMs: 900_000,
  evidenceResumeSweepLimit: 25,
  evidenceFreshnessHours: 24,
  evidencePointsReserve: 1_500,
  evidenceKillSettleDays: 7,
  evidenceRetryCostCeiling: 250,
  evidenceFailureCooldownMs: 1_800_000,
  evidenceParseRequestCap: 8,
  evidenceTierSearchRequestCap: 60,
  blizzardSweepRequestCap: 300,
  blizzardHourlyRequestBudget: 28_800,
  fingerprintMinimumCommon: 200,
  fingerprintMinimumIdenticalPercent: 20,
  fingerprintSweepCadenceHours: 168,
  evidenceJobCredentialEncryptionKey: Buffer.alloc(32, "a")
};

function runtimeFakes(
  options: {
    probeHasCompletedRun?: boolean;
    queueDepthRows?: Array<Record<string, unknown>> | Error;
  } = {}
) {
  let connectionAttempts = 0;
  let ended = false;
  let queueReady = false;
  let workHandler:
    | ((
        payload: DiscoverCharacterJob,
        context: DiscoveryWorkContext
      ) => Promise<void>)
    | undefined;
  let maintenanceHandler: (() => Promise<void>) | undefined;
  let evidenceResumeHandler: (() => Promise<void>) | undefined;
  let admissionHandler: ((runId: string) => Promise<void>) | undefined;
  let evidenceWorkHandler:
    | ((
        payload: { runId: string },
        context: DiscoveryWorkContext
      ) => Promise<void>)
    | undefined;
  const pendingDispatches: DiscoverCharacterJob[] = [];
  const recoveredDispatches: string[] = [];
  const enqueued: DiscoverCharacterJob[] = [];
  const evidenceEnqueues: Array<{
    runId: string;
    meta: unknown;
  }> = [];
  const fingerprintAdmissions: string[] = [];
  const waitingFingerprintRuns: string[] = [];
  const admittedFingerprintRuns = new Set<string>();
  const admittedUndispatchedFingerprintRuns: string[] = [];
  const dispatchedFingerprintRuns: string[] = [];
  let resumeState: {
    resumeAfter: string;
    snapshotId: string;
    /** The run that published `snapshotId`, and so owns this cursor. */
    runId: string;
    limitationCode: string | null;
  } | null = null;
  const queue: DiscoveryQueue = {
    async start() {
      queueReady = true;
    },
    async enqueue(payload) {
      enqueued.push(payload);
      return payload.runId;
    },
    async enqueueFingerprintAdmission(runId) {
      fingerprintAdmissions.push(runId);
      return runId;
    },
    async enqueueCharacterEvidence(runId, meta) {
      evidenceEnqueues.push({ runId, meta });
      return runId;
    },
    async work(handler) {
      workHandler = handler;
    },
    async scheduleMaintenanceCleanup(handler) {
      maintenanceHandler = handler;
    },
    async scheduleEvidenceResume(handler) {
      evidenceResumeHandler = handler;
    },
    async settledEvidenceJobIds(jobIds: readonly string[]) {
      return jobIds.filter((id) => settledEvidenceJobs.includes(id));
    },
    async workFingerprintAdmissions(handler) {
      admissionHandler = handler;
    },
    async workCharacterEvidence(handler) {
      evidenceWorkHandler = handler;
    },
    async stop() {
      queueReady = false;
    },
    isReady() {
      return queueReady;
    }
  };
  const handler: DiscoveryJobHandler = { execute: vi.fn(async () => {}) };
  const evidenceHandler: ApplicantEvidenceJobHandler = {
    execute: vi.fn(async () => {})
  };
  const queueDepthQueries: Array<unknown[] | undefined> = [];
  const pool = {
    async query(text: string, values?: unknown[]) {
      if (text.includes("oldest_wait_ms")) {
        queueDepthQueries.push(values);
        if (options.queueDepthRows instanceof Error) {
          throw options.queueDepthRows;
        }
        return { rows: options.queueDepthRows ?? [] };
      }
      if (text.includes("MAX(completed_at)")) {
        const noRunAge = text.includes(
          "WHEN MAX(completed_at) IS NULL THEN NULL"
        )
          ? null
          : "0";
        return {
          rows: [
            {
              last_successful_run_age_ms:
                options.probeHasCompletedRun === false ? noRunAge : "12345",
              queue_depth: "2"
            }
          ]
        };
      }
      connectionAttempts += 1;
      if (connectionAttempts < 3) throw new Error("database_starting");
      return { rows: [{ "?column?": 1 }] };
    },
    async end() {
      ended = true;
    }
  };
  const migrations = vi.fn(async () => {});
  const cleanup = {
    rateLimits: vi.fn(async () => 2),
    negativeCache: vi.fn(async () => 3),
    suppressions: vi.fn(async () => 4),
    fingerprintRequests: vi.fn(async () => 5),
    evidence: vi.fn(async (cutoffs: { settled: Date; active: Date }) => {
      void cutoffs;
      return 6;
    }),
    evidenceRunCosts: vi.fn(async (cutoff: Date) => {
      void cutoff;
      return 7;
    })
  };
  // The resume sweep's three calls, kept addressable so a test can say what is
  // due and then assert the sweep reserved and enqueued it.
  const resumable: CharacterKey[] = [];
  const listResumable = vi.fn(async () => {
    sweepOrder.push("listResumable");
    return resumable;
  });
  const evidenceReserve = vi.fn(
    async (
      input: Record<string, unknown>
    ): Promise<{ kind: string; run: { id: string } | null }> => {
      void input;
      return { kind: "existing", run: null };
    }
  );
  const evidenceMarkEnqueued = vi.fn(async () => {});
  // Recovery's two calls. `activeEvidenceRuns` is what the reservation gate
  // still counts as active; `settledEvidenceJobs` is what the queue says
  // nothing is working on any more.
  const activeEvidenceRuns: Array<{
    runId: string;
    key: { region: "eu"; realm: string; name: string };
    queueJobId: string | null;
    startedAt: Date | null;
    createdAt: Date;
  }> = [];
  const settledEvidenceJobs: string[] = [];
  const sweepOrder: string[] = [];
  const listActive = vi.fn(async () => {
    sweepOrder.push("listActive");
    return activeEvidenceRuns;
  });
  const releaseAbandoned = vi.fn(
    async (runIds: readonly string[]) => runIds.length
  );
  // No stage by default, so recovery releases -- the arms these tests exercise
  // are about which runs it judges abandoned, not what it does with the scan.
  const stagedCollection = vi.fn(
    async (): Promise<StagedEvidenceCollection | null> => null
  );
  const repositories = {
    evidence: {
      clearStaleCredentials: cleanup.evidence,
      clearExpiredRunCosts: cleanup.evidenceRunCosts,
      async clearSettledCollectionStages() {
        return 0;
      },
      async find() {
        return null;
      },
      async claim() {
        return null;
      },
      async publish() {},
      async fail() {},
      stagedCollection,
      async markTerminalTiers() {},
      reserve: evidenceReserve,
      async getCompleted() {
        return null;
      },
      listResumable: listResumable,
      listActive,
      releaseAbandoned,
      markEnqueued: evidenceMarkEnqueued,
      async listStatus() {
        return [];
      }
    },
    searchReservations: {
      async listPending() {
        return [...pendingDispatches];
      },
      async markEnqueued(runId: string) {
        recoveredDispatches.push(runId);
      }
    },
    rateLimits: { cleanupExpired: cleanup.rateLimits },
    negativeCache: { cleanupExpired: cleanup.negativeCache },
    suppressions: { cleanupExpired: cleanup.suppressions },
    fingerprintSweeps: {
      async admitWaiting(runId: string) {
        return admittedFingerprintRuns.has(runId)
          ? { kind: "admitted" as const }
          : { kind: "waiting" as const, retryAt: new Date() };
      },
      async listWaiting(limit: number, offset = 0) {
        return waitingFingerprintRuns.slice(offset, offset + limit);
      },
      async listAdmittedUndispatched() {
        return [...admittedUndispatchedFingerprintRuns];
      },
      async markDispatched(runId: string) {
        dispatchedFingerprintRuns.push(runId);
        const index = admittedUndispatchedFingerprintRuns.indexOf(runId);
        if (index >= 0) admittedUndispatchedFingerprintRuns.splice(index, 1);
      },
      async getResumeState() {
        return resumeState;
      },
      cleanupExpired: cleanup.fingerprintRequests
    }
  } as unknown as Repositories;
  const sleeps: number[] = [];

  return {
    dependencies: {
      createPool: () => pool,
      runMigrations: migrations,
      createRepositories: () => repositories,
      createQueue: () => queue,
      createGateway: () => ({}) as RaiderIoGateway,
      createEvidenceGateway: () =>
        ({}) as Pick<
          WarcraftLogsGateway,
          "getFirstKillReports" | "getRateLimit"
        >,
      createEvidenceHandler: (options: ApplicantEvidenceJobHandlerOptions) => {
        void options;
        return evidenceHandler;
      },
      createHandler: (options: DiscoveryJobHandlerOptions) => {
        void options;
        return handler;
      },
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
      }
    },
    handler,
    evidenceHandler,
    migrations,
    cleanup,
    repositories,
    pendingDispatches,
    recoveredDispatches,
    enqueued,
    evidenceEnqueues,
    fingerprintAdmissions,
    waitingFingerprintRuns,
    admittedFingerprintRuns,
    admittedUndispatchedFingerprintRuns,
    dispatchedFingerprintRuns,
    setResumeState: (state: typeof resumeState) => {
      resumeState = state;
    },
    queue,
    get connectionAttempts() {
      return connectionAttempts;
    },
    get ended() {
      return ended;
    },
    get workHandler() {
      return workHandler;
    },
    get maintenanceHandler() {
      return maintenanceHandler;
    },
    activeEvidenceRuns,
    settledEvidenceJobs,
    sweepOrder,
    listActive,
    releaseAbandoned,
    stagedCollection,
    queueDepthQueries,
    get evidenceResumeHandler() {
      return evidenceResumeHandler;
    },
    resumable,
    listResumable,
    evidenceReserve,
    evidenceMarkEnqueued,
    get admissionHandler() {
      return admissionHandler;
    },
    get evidenceWorkHandler() {
      return evidenceWorkHandler;
    },
    sleeps
  };
}

describe("worker runtime", () => {
  it("composes the worker-only Blizzard gateway and fingerprint limits", () => {
    // Break caught: worker configuration could be loaded but never reach the
    // fingerprint handler, leaving the private sweep feature dormant.
    const integration = createFingerprintIntegration(config);

    expect(integration.blizzardGateway).toMatchObject({
      getGuildRoster: expect.any(Function),
      getAchievementFingerprint: expect.any(Function)
    });
    expect(integration.fingerprint).toEqual({
      requestCap: 300,
      hourlyBudget: 28_800,
      cadenceMs: 604_800_000,
      minimumCommon: 200,
      minimumIdenticalPercent: 20
    });
  });

  it("routes a throttled Blizzard response through the worker's own upstream_throttle record", async () => {
    // Break caught: the worker composition root could stop passing onThrottle
    // to the Blizzard client it constructs (or never wire it in the first
    // place) with nothing here to notice -- upstream throttling would then
    // vanish from the logs.
    const logger = { info: vi.fn() };
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "30" }
        })
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    try {
      const integration = createFingerprintIntegration(config, logger);
      await expect(
        integration.blizzardGateway!.getCompletedAchievements({
          region: "eu",
          realm: "silvermoon",
          name: "sentinel"
        })
      ).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(logger.info).toHaveBeenCalledWith({
      event: "upstream_throttle",
      provider: "blizzard",
      retryAfterMs: 30_000
    });
  });

  it("announces a discovery run as a message Discord will accept", async () => {
    // Break caught: posting the raw alert object is rejected by Discord with
    // 400 "Cannot send an empty message", so every announcement would be lost
    // to a swallowed failure.
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const notifier = createDiscoveryRunNotifier(
      {
        ...config,
        discoveryWebhookUrl:
          "https://discord.com/api/webhooks/000000000000000000/token"
      },
      { fetch }
    );

    await notifier.started({
      runId: "a1b2c3d4-0000-4000-8000-000000000001",
      region: "eu",
      realm: "silvermoon",
      name: "Sentinel",
      attempt: 2
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]! as unknown as [
      string,
      RequestInit
    ];
    expect(url).toBe(
      "https://discord.com/api/webhooks/000000000000000000/token"
    );
    const body = JSON.parse(String(init.body)) as { content?: string };
    expect(body.content).toContain("Sentinel");
    expect(body.content).toContain("eu/silvermoon");
    expect(body.content).toContain("attempt 2");
  });

  it("posts nothing when no discovery webhook is configured", async () => {
    // Break caught: an unset webhook must cost no request at all, not a call
    // to an empty URL that throws on every run.
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const notifier = createDiscoveryRunNotifier(
      { ...config, discoveryWebhookUrl: undefined },
      { fetch }
    );

    await notifier.started({
      runId: "a1b2c3d4-0000-4000-8000-000000000001",
      region: "eu",
      realm: "silvermoon",
      name: "Sentinel",
      attempt: 1
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("swallows and logs a rejected discovery announcement", async () => {
    // Break caught: Discord rate limits a busy webhook, and a 429 that
    // propagated would fail the discovery run it was only describing.
    const logger = { info: vi.fn() };
    const fetch = vi.fn(async () => new Response(null, { status: 429 }));
    const notifier = createDiscoveryRunNotifier(
      {
        ...config,
        discoveryWebhookUrl:
          "https://discord.com/api/webhooks/000000000000000000/token"
      },
      { logger, fetch }
    );

    await expect(
      notifier.started({
        runId: "a1b2c3d4-0000-4000-8000-000000000001",
        region: "eu",
        realm: "silvermoon",
        name: "Sentinel",
        attempt: 1
      })
    ).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith({
      event: "discovery_announcement_delivery_failed",
      failure: "http_status",
      status: 429
    });
  });

  it("announces an evidence run starting as a message Discord will accept", async () => {
    // Break caught: posting the raw record is rejected by Discord with 400
    // "Cannot send an empty message", so every announcement would be lost to
    // a swallowed failure.
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const notifier = createEvidenceRunNotifier(
      {
        ...config,
        discoveryWebhookUrl:
          "https://discord.com/api/webhooks/000000000000000000/token"
      },
      { fetch }
    );

    await notifier.started({
      runId: "a1b2c3d4-0000-4000-8000-000000000001",
      region: "eu",
      realm: "silvermoon",
      name: "Sentinel",
      attempt: 2
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]! as unknown as [
      string,
      RequestInit
    ];
    expect(url).toBe(
      "https://discord.com/api/webhooks/000000000000000000/token"
    );
    const body = JSON.parse(String(init.body)) as { content?: string };
    expect(body.content).toContain("Sentinel");
    expect(body.content).toContain("eu/silvermoon");
    expect(body.content).toContain("attempt 2");
  });

  it("names the limitations and the points an evidence run ended on", async () => {
    // Break caught: #288's whole case is that `parse_schema_drift` and a
    // drained allowance were invisible, so an outcome message that omits them
    // announces nothing anyone needed.
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const notifier = createEvidenceRunNotifier(
      {
        ...config,
        discoveryWebhookUrl:
          "https://discord.com/api/webhooks/000000000000000000/token"
      },
      { fetch }
    );

    await notifier.finished({
      runId: "a1b2c3d4-0000-4000-8000-000000000001",
      region: "eu",
      realm: "silvermoon",
      name: "rinn",
      attempt: 1,
      outcome: "partial",
      limitationCode: "parse_schema_drift",
      parseLimitationCode: "schema_changed",
      pointsSpent: 4_200
    });

    const [, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { content?: string };
    expect(body.content).toContain("rinn");
    expect(body.content).toContain("partial");
    expect(body.content).toContain("parse_schema_drift");
    expect(body.content).toContain("schema_changed");
    expect(body.content).toContain("4200 points");
  });

  it("omits the points from an evidence outcome that could not measure them", async () => {
    // Break caught: the allowance is not always readable, and rendering the
    // absent value would announce "null points" on every such run.
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const notifier = createEvidenceRunNotifier(
      {
        ...config,
        discoveryWebhookUrl:
          "https://discord.com/api/webhooks/000000000000000000/token"
      },
      { fetch }
    );

    await notifier.finished({
      runId: "a1b2c3d4-0000-4000-8000-000000000001",
      region: "eu",
      realm: "silvermoon",
      name: "rinn",
      attempt: 1,
      outcome: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      pointsSpent: null
    });

    const [, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { content?: string };
    expect(body.content).toContain("complete");
    expect(body.content).not.toContain("null");
    expect(body.content).not.toContain("points");
  });

  it("posts nothing for an evidence run when no webhook is configured", async () => {
    // Break caught: an unset webhook must cost no request at all, not a call
    // to an empty URL that throws on every run.
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const notifier = createEvidenceRunNotifier(
      { ...config, discoveryWebhookUrl: undefined },
      { fetch }
    );

    await notifier.started({
      runId: "a1b2c3d4-0000-4000-8000-000000000001",
      region: "eu",
      realm: "silvermoon",
      name: "rinn",
      attempt: 1
    });
    await notifier.finished({
      runId: "a1b2c3d4-0000-4000-8000-000000000001",
      region: "eu",
      realm: "silvermoon",
      name: "rinn",
      attempt: 1,
      outcome: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      pointsSpent: null
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("swallows and logs a rejected evidence announcement", async () => {
    // Break caught: a ten-character sweep announces twice per run, which is
    // squarely inside Discord's rate limit, and a 429 that propagated would
    // fail the evidence run it was only describing.
    const logger = { info: vi.fn() };
    const fetch = vi.fn(async () => new Response(null, { status: 429 }));
    const notifier = createEvidenceRunNotifier(
      {
        ...config,
        discoveryWebhookUrl:
          "https://discord.com/api/webhooks/000000000000000000/token"
      },
      { logger, fetch }
    );

    await expect(
      notifier.finished({
        runId: "a1b2c3d4-0000-4000-8000-000000000001",
        region: "eu",
        realm: "silvermoon",
        name: "rinn",
        attempt: 1,
        outcome: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        pointsSpent: null
      })
    ).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith({
      event: "evidence_announcement_delivery_failed",
      failure: "http_status",
      status: 429
    });
  });

  it("swallows and logs an evidence announcement that never returns", async () => {
    // Break caught: a stalled webhook request would hold the evidence run
    // open behind a chat message it does not depend on.
    const logger = { info: vi.fn() };
    const fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const notifier = createEvidenceRunNotifier(
      {
        ...config,
        discoveryWebhookUrl:
          "https://discord.com/api/webhooks/000000000000000000/token"
      },
      { logger, fetch }
    );

    await expect(
      notifier.started({
        runId: "a1b2c3d4-0000-4000-8000-000000000001",
        region: "eu",
        realm: "silvermoon",
        name: "rinn",
        attempt: 1
      })
    ).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith({
      event: "evidence_announcement_delivery_failed",
      failure: "network_or_timeout"
    });
  });

  it("formats count-only maintainer alerts for a Discord channel webhook", async () => {
    const fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toContain("discord.com/api/webhooks/");
        expect(init?.method).toBe("POST");
        return new Response(null, { status: 204 });
      }
    );
    const notifier = createFingerprintAlertNotifier(
      {
        ...config,
        maintainerAlertWebhookUrl:
          "https://discord.com/api/webhooks/000000000000000000/token"
      },
      { fetch }
    );

    await notifier.notify({
      event: "applicant_backlog_pressure",
      details: { backlog: 80, limit: 100 }
    });

    const request = fetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      content: "⚠️ applicant_backlog_pressure — backlog: 80 · limit: 100",
      allowed_mentions: { parse: [] }
    });
  });

  it("uses an arrival icon for a new application alert", async () => {
    const fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toContain("discord.com/api/webhooks/");
        expect(init?.method).toBe("POST");
        return new Response(null, { status: 204 });
      }
    );
    const notifier = createFingerprintAlertNotifier(
      {
        ...config,
        maintainerAlertWebhookUrl:
          "https://discord.com/api/webhooks/000000000000000000/token"
      },
      { fetch }
    );

    await notifier.notify({
      event: "applicant_new_intents",
      details: { count: 2 }
    });

    const request = fetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      content: "📨 applicant_new_intents — count: 2",
      allowed_mentions: { parse: [] }
    });
  });

  it("renders applicant details without Discord mentions or markdown injection", async () => {
    const fetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => {
        void _url;
        void _init;
        return new Response(null, { status: 204 });
      }
    );
    const notifier = createFingerprintAlertNotifier(
      {
        ...config,
        maintainerAlertWebhookUrl:
          "https://discord.com/api/webhooks/000000000000000000/token"
      },
      { fetch }
    );
    await notifier.notify({
      event: "applicant_new_intents",
      details: { count: 1 },
      applicant: {
        battletag: "@everyone *Aria*\nDossier: https://evil.example",
        discordId: "<@123456789012345678>",
        characterName: "[Aria](https://evil.example)",
        characterUrl: "https://raider.io/characters/eu/example/aria",
        dossierUrl: "https://web-test.example.test/dossiers/eu/example/aria"
      }
    });
    const body = JSON.parse(
      (fetch.mock.calls[0]![1] as RequestInit).body as string
    ) as { content: string; allowed_mentions: unknown };
    expect(body.content).toContain("Battletag: @ everyone \\*Aria\\*");
    expect(body.content).not.toContain("\nDossier: https://evil.example");
    expect(body.content).toContain("Discord ID: < @ 123456789012345678\\>");
    expect(body.content).toContain("Character: \\[Aria\\]");
    expect(body.content).toContain(
      "Character link: https://raider.io/characters/eu/example/aria"
    );
    expect(body.content).toContain(
      "Dossier: https://web-test.example.test/dossiers/eu/example/aria"
    );
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("swallows and logs a non-successful maintainer webhook response", async () => {
    // Break caught: a provider outage could reject discovery work and cause the
    // durable job to retry after its sweep had already changed state.
    const logger = { info: vi.fn() };
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    const notifier = createFingerprintAlertNotifier(
      {
        ...config,
        maintainerAlertWebhookUrl:
          "https://hooks.example.test/services/T000/B000/token?wait=true"
      },
      { logger, fetch }
    );

    await expect(
      notifier.notify({
        event: "fingerprint_reservation_pressure",
        details: { committedRequests: 95, hourlyBudget: 100 }
      })
    ).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith({
      event: "maintainer_alert_delivery_failed",
      alertEvent: "fingerprint_reservation_pressure",
      failure: "http_status",
      status: 503
    });
  });

  it("times out and swallows a stalled maintainer webhook request", async () => {
    // Break caught: an unresponsive webhook could strand a sweep indefinitely
    // even though alert delivery is only an operational side effect.
    const logger = { info: vi.fn() };
    let requestSignal: AbortSignal | null | undefined;
    const fetch = vi.fn(
      async (
        _input: string | URL | Request,
        init?: RequestInit
      ): Promise<Response> => {
        requestSignal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true }
          );
        });
      }
    );
    const notifier = createFingerprintAlertNotifier(
      {
        ...config,
        maintainerAlertWebhookUrl:
          "https://hooks.example.test/services/T000/B000/token?wait=true"
      },
      { logger, fetch, timeoutMs: 5 }
    );

    await expect(
      notifier.notify({
        event: "fingerprint_admission_blocked",
        details: { blockedForMs: 900_000 }
      })
    ).resolves.toBeUndefined();
    expect(requestSignal?.aborted).toBe(true);
    expect(logger.info).toHaveBeenCalledWith({
      event: "maintainer_alert_delivery_failed",
      alertEvent: "fingerprint_admission_blocked",
      failure: "network_or_timeout"
    });
  });

  it("retries database startup before becoming ready and registering work", async () => {
    // Break caught: an independently-started worker could exit before PostgreSQL is ready.
    const fakes = runtimeFakes();

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    expect(fakes.connectionAttempts).toBe(3);
    expect(fakes.sleeps).toEqual([10, 20]);
    expect(fakes.migrations).toHaveBeenCalledOnce();
    expect(fakes.workHandler).toBeTypeOf("function");
    await expect(runtime.health()).resolves.toEqual({
      live: true,
      ready: true
    });
  });

  it("reports aggregate worker progress without run or character identity", async () => {
    // Break caught: the probe could report readiness alone, or select and
    // expose the identity-bearing rows used to calculate aggregate health.
    const fakes = runtimeFakes();

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    await expect(runtime.probe()).resolves.toEqual({
      ready: true,
      lastSuccessfulRunAgeMs: 12_345,
      queueDepth: 2
    });
  });

  it("keeps a worker with no successful run distinguishable from a fresh success", async () => {
    // Break caught: PostgreSQL GREATEST ignores a NULL aggregate when another
    // argument is non-NULL, which could turn "never succeeded" into age zero.
    const fakes = runtimeFakes({ probeHasCompletedRun: false });

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    await expect(runtime.probe()).resolves.toEqual({
      ready: true,
      lastSuccessfulRunAgeMs: null,
      queueDepth: 2
    });
  });

  it("gives the discovery handler the redacting worker logger", async () => {
    // Break caught: discovery could run with no operational logging at all.
    const fakes = runtimeFakes();
    const logger = { info() {} };
    let handlerOptions: DiscoveryJobHandlerOptions | undefined;
    fakes.dependencies.createHandler = (
      options: DiscoveryJobHandlerOptions
    ) => {
      handlerOptions = options;
      return fakes.handler;
    };

    const runtime = await createWorkerRuntime(
      config,
      fakes.dependencies,
      logger
    );

    expect(handlerOptions?.logger).toBe(logger);
    await runtime.stop();
  });

  it("passes the evidence run notifier to the evidence handler", async () => {
    // Break caught: #288 is exactly this wiring going missing — the notifier
    // can be built correctly and still never reach the handler that spends
    // the Warcraft Logs allowance, leaving evidence runs silent.
    const fakes = runtimeFakes();
    const notifier: EvidenceRunNotifier = {
      started: () => {},
      finished: () => {}
    };
    let evidenceOptions: ApplicantEvidenceJobHandlerOptions | undefined;
    Object.assign(fakes.dependencies, {
      createEvidenceRunNotifier: () => notifier,
      createEvidenceHandler(options: ApplicantEvidenceJobHandlerOptions) {
        evidenceOptions = options;
        return fakes.evidenceHandler;
      }
    });

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    expect(evidenceOptions?.evidenceRunNotifier).toBe(notifier);
    await runtime.stop();
  });

  it("passes an injected fingerprint integration to the discovery handler", async () => {
    // Break caught: Task 6 composition could construct Blizzard dependencies
    // that the runtime silently drops before handler orchestration.
    const fakes = runtimeFakes();
    const blizzardGateway = {} as NonNullable<
      DiscoveryJobHandlerOptions["blizzardGateway"]
    >;
    let handlerOptions: DiscoveryJobHandlerOptions | undefined;
    Object.assign(fakes.dependencies, {
      createFingerprintIntegration: () => ({
        blizzardGateway,
        fingerprint: {
          requestCap: 300,
          hourlyBudget: 28_800,
          cadenceMs: 604_800_000,
          minimumCommon: 200,
          minimumIdenticalPercent: 20
        }
      }),
      createHandler(options: DiscoveryJobHandlerOptions) {
        handlerOptions = options;
        return fakes.handler;
      }
    });

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    expect(handlerOptions).toMatchObject({
      blizzardGateway,
      fingerprint: {
        requestCap: 300,
        hourlyBudget: 28_800,
        cadenceMs: 604_800_000,
        minimumCommon: 200,
        minimumIdenticalPercent: 20
      }
    });
    await runtime.stop();
  });

  it("wires newly discovered fingerprint characters to a full evidence collection", async () => {
    // Break caught: discovery could publish a new connection but leave it with
    // no WCL run, so its historical guilds would never become sweep sources.
    const fakes = runtimeFakes();
    let handlerOptions: DiscoveryJobHandlerOptions | undefined;
    fakes.evidenceReserve.mockResolvedValueOnce({
      kind: "reserved",
      run: { id: "evidence-run" }
    });
    fakes.dependencies.createHandler = (options) => {
      handlerOptions = options;
      return fakes.handler;
    };

    const runtime = await createWorkerRuntime(config, fakes.dependencies);
    await handlerOptions?.enqueueFullEvidence?.({
      region: "eu",
      realm: "draenor",
      name: "mistakinus"
    });

    expect(fakes.evidenceReserve).toHaveBeenCalledWith(
      expect.objectContaining({
        key: { region: "eu", realm: "draenor", name: "mistakinus" }
      })
    );
    expect(fakes.evidenceEnqueues).toEqual([
      {
        runId: "evidence-run",
        meta: expect.objectContaining({ mode: "full" })
      }
    ]);
    expect(fakes.evidenceMarkEnqueued).toHaveBeenCalledWith(
      "evidence-run",
      "evidence-run"
    );
    await runtime.stop();
  });

  it("registers worker-owned Warcraft Logs evidence collection", async () => {
    // Break caught: evidence jobs could be queued successfully but no worker
    // would ever claim them, leaving dossier history permanently stale.
    const fakes = runtimeFakes();
    let handlerOptions: ApplicantEvidenceJobHandlerOptions | undefined;
    const warcraftLogs = {} as Pick<
      WarcraftLogsGateway,
      "getFirstKillReports" | "getRateLimit"
    >;
    Object.assign(fakes.dependencies, {
      createEvidenceGateway: () => warcraftLogs,
      createEvidenceHandler(options: ApplicantEvidenceJobHandlerOptions) {
        handlerOptions = options;
        return fakes.evidenceHandler;
      }
    });

    const runtime = await createWorkerRuntime(config, fakes.dependencies);
    const context = {
      attempt: 1,
      maxAttempts: 5,
      signal: new AbortController().signal
    };

    expect(handlerOptions).toMatchObject({
      warcraftLogs,
      createWarcraftLogsGateway: expect.any(Function),
      decryptionKey: config.evidenceJobCredentialEncryptionKey,
      requestCap: 500,
      parseRequestCap: 8,
      pointsReserve: config.evidencePointsReserve,
      evidence: (
        fakes.repositories as typeof fakes.repositories & {
          evidence: unknown;
        }
      ).evidence
    });
    const payload = {
      runId: "00000000-0000-4000-8000-000000000006",
      correlationId: "c1",
      enqueuedAt: "2026-09-13T12:00:00.000Z"
    };
    await fakes.evidenceWorkHandler?.(payload, context);
    expect(fakes.evidenceHandler.execute).toHaveBeenCalledWith(
      payload,
      context
    );
    await runtime.stop();
  });

  it("routes only run ids to the handler", async () => {
    // Break caught: private character lookup values could be forwarded into logs or handlers.
    const fakes = runtimeFakes();
    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    const context = {
      attempt: 3,
      maxAttempts: 5,
      signal: new AbortController().signal
    };
    const payload = {
      runId: "00000000-0000-4000-8000-000000000003",
      key: { region: "eu" as const, realm: "silvermoon", name: "private-value" }
    };
    await fakes.workHandler?.(payload, context);

    expect(fakes.handler.execute).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000003",
      context,
      payload
    );
    await runtime.stop();
  });

  it("forwards the queue payload's correlation id and enqueue time to the discovery handler", async () => {
    // Break caught: Task 7 wired correlationId/enqueuedAt onto the queue
    // payload, but the work() callback here discarded them before ever
    // reaching the handler, leaving discovery_run's correlation and
    // queue-wait fields permanently null.
    const fakes = runtimeFakes();
    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    const context = {
      attempt: 1,
      maxAttempts: 5,
      signal: new AbortController().signal
    };
    const payload = {
      runId: "00000000-0000-4000-8000-000000000004",
      key: {
        region: "eu" as const,
        realm: "silvermoon",
        name: "private-value"
      },
      correlationId: "corr-4",
      enqueuedAt: "2026-08-05T08:00:00.000Z"
    };
    await fakes.workHandler?.(payload, context);

    expect(fakes.handler.execute).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000004",
      {
        ...context,
        correlationId: "corr-4",
        enqueuedAt: "2026-08-05T08:00:00.000Z"
      },
      payload
    );
    await runtime.stop();
  });

  it("opens a throttle unit named for the run around each job it dispatches", async () => {
    // Break caught: the handlers only bind their scope to a unit someone else
    // opened, so a dispatch that stopped opening one would leave every
    // throttle off discovery_run and evidence_job with no error (#508).
    const fakes = runtimeFakes();
    const runtime = await createWorkerRuntime(config, fakes.dependencies);
    const lines: Record<string, unknown>[] = [];
    vi.mocked(fakes.handler.execute).mockImplementation(async () => {
      lines.push(upstreamThrottleRecord("blizzard", { retryAfterMs: 1 }));
    });
    vi.mocked(fakes.evidenceHandler.execute).mockImplementation(async () => {
      lines.push(upstreamThrottleRecord("warcraftlogs", { retryAfterMs: 1 }));
    });
    const context = {
      attempt: 1,
      maxAttempts: 5,
      signal: new AbortController().signal
    };

    await fakes.workHandler?.(
      {
        runId: "00000000-0000-4000-8000-000000000011",
        key: { region: "eu", realm: "silvermoon", name: "root" }
      },
      context
    );
    await fakes.evidenceWorkHandler?.(
      { runId: "00000000-0000-4000-8000-000000000012" },
      context
    );

    expect(lines).toEqual([
      expect.objectContaining({
        runId: "00000000-0000-4000-8000-000000000011"
      }),
      expect.objectContaining({
        runId: "00000000-0000-4000-8000-000000000012"
      })
    ]);
    await runtime.stop();
  });

  it("registers maintenance cleanup through the durable queue", async () => {
    // Break caught: expired abuse and suppression policy rows could accumulate forever.
    const fakes = runtimeFakes();
    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    expect(fakes.maintenanceHandler).toBeTypeOf("function");
    await fakes.maintenanceHandler?.();
    expect(fakes.cleanup.rateLimits).toHaveBeenCalledOnce();
    expect(fakes.cleanup.negativeCache).toHaveBeenCalledOnce();
    expect(fakes.cleanup.suppressions).toHaveBeenCalledOnce();
    expect(fakes.cleanup.fingerprintRequests).toHaveBeenCalledOnce();
    expect(fakes.cleanup.evidence).toHaveBeenCalledOnce();
    const [cutoffs] = fakes.cleanup.evidence.mock.calls[0]!;
    const settledAgeMs = Date.now() - cutoffs.settled.getTime();
    expect(settledAgeMs).toBeGreaterThanOrEqual(60 * 60_000 - 5_000);
    expect(settledAgeMs).toBeLessThan(60 * 60_000 + 5_000);
    // Break caught: a run still waiting out a points-budget deferral -- up to
    // five attempts of 1800 seconds -- would cross a one-hour cutoff while
    // live, lose its credentials, and silently spend the worker's shared
    // allowance on a visitor's dossier. The active window must outlive that
    // chain by a clear margin.
    const activeAgeMs = Date.now() - cutoffs.active.getTime();
    expect(activeAgeMs).toBeGreaterThan(5 * 1_800_000);
    await runtime.stop();
  });

  it("expires recorded run costs at four weeks", async () => {
    // Retention is weeks rather than years on purpose (#342): an older row
    // describes a configuration that no longer runs, and a budget re-derived
    // from one is the trap the table was built to close.
    const fakes = runtimeFakes();
    const logged: Array<Record<string, unknown>> = [];
    const runtime = await createWorkerRuntime(config, fakes.dependencies, {
      info: (record) => logged.push(record)
    });

    await fakes.maintenanceHandler?.();

    expect(fakes.cleanup.evidenceRunCosts).toHaveBeenCalledOnce();
    const [cutoff] = fakes.cleanup.evidenceRunCosts.mock.calls[0]!;
    const ageMs = Date.now() - cutoff.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(28 * 24 * 60 * 60_000 - 5_000);
    expect(ageMs).toBeLessThan(28 * 24 * 60 * 60_000 + 5_000);
    // A count, never a run id or a character key, like the two beside it.
    expect(logged).toContainEqual(
      expect.objectContaining({
        event: "evidence_cache_cleanup",
        removedRunCosts: 7
      })
    );
    await runtime.stop();
  });

  it("drives a waiting evidence run without a reader", async () => {
    // Break caught: a run that set `retry_after_at` became eligible to resume
    // and nothing scheduled it, so collection continued only when somebody
    // happened to load the dossier -- which made the dossier nobody was
    // watching the one that quietly never finished.
    const fakes = runtimeFakes();
    fakes.resumable.push({
      region: "eu",
      realm: "silvermoon",
      name: "ryii"
    });
    fakes.evidenceReserve.mockResolvedValue({
      kind: "reserved",
      run: { id: "00000000-0000-4000-8000-000000000021" }
    });
    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    expect(fakes.evidenceResumeHandler).toBeTypeOf("function");
    await fakes.evidenceResumeHandler?.();

    expect(fakes.listResumable).toHaveBeenCalledWith(25, expect.any(Date));
    expect(fakes.evidenceReserve).toHaveBeenCalledOnce();
    // No credentials: a sweep has no visitor, so it must not reserve with a
    // stranger's Warcraft Logs key and spend their allowance.
    expect(fakes.evidenceReserve.mock.calls[0]?.[0]).not.toHaveProperty(
      "credentials"
    );
    expect(fakes.evidenceMarkEnqueued).toHaveBeenCalledOnce();
    await runtime.stop();
  });

  it("releases an evidence run abandoned in running on the same sweep", async () => {
    // Break caught: #305. A run whose worker is killed mid-flight stays
    // `running` for ever, so `reserve` reports the character as collecting and
    // the resume sweep skips it -- the one character recovery cannot reach is
    // the one that needs it. Recovery rides the five-minute sweep rather than
    // the hourly cleanup for the same reason the resume sweep does.
    const fakes = runtimeFakes();
    fakes.activeEvidenceRuns.push({
      runId: "00000000-0000-4000-8000-000000000031",
      key: { region: "eu" as const, realm: "silvermoon", name: "adeline" },
      queueJobId: "00000000-0000-4000-8000-000000000032",
      startedAt: new Date(Date.now() - 20 * 60_000),
      createdAt: new Date(Date.now() - 21 * 60_000)
    });
    fakes.settledEvidenceJobs.push("00000000-0000-4000-8000-000000000032");
    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    await fakes.evidenceResumeHandler?.();

    expect(fakes.releaseAbandoned).toHaveBeenCalledWith([
      "00000000-0000-4000-8000-000000000031"
    ]);
    await runtime.stop();
  });

  it("records each queue's depth and oldest wait on every sweep", async () => {
    // #509: the probe gives depth only on demand, so nothing recorded the
    // backlog a slow run or a queueWaitMs spike could be read against. A
    // queue with nothing waiting still appears, at zero, so a gap in the
    // series means the tick did not run rather than an empty queue.
    const fakes = runtimeFakes({
      queueDepthRows: [
        {
          name: "collect-character-evidence",
          depth: "3",
          oldest_wait_ms: "90500.4"
        }
      ]
    });
    const logger = { info: vi.fn() };
    const runtime = await createWorkerRuntime(
      config,
      fakes.dependencies,
      logger
    );

    await fakes.evidenceResumeHandler?.();

    expect(fakes.queueDepthQueries).toEqual([
      [
        [
          "discover-character",
          "fingerprint-admission",
          "collect-character-evidence"
        ]
      ]
    ]);
    expect(logger.info).toHaveBeenCalledWith({
      event: "queue_depth",
      queues: {
        "discover-character": { depth: 0, oldestWaitMs: null },
        "fingerprint-admission": { depth: 0, oldestWaitMs: null },
        "collect-character-evidence": { depth: 3, oldestWaitMs: 90500 }
      }
    });
    await runtime.stop();
  });

  it("still sweeps when the queue depth read fails", async () => {
    const fakes = runtimeFakes({ queueDepthRows: new RangeError("boom") });
    const logger = { info: vi.fn() };
    const runtime = await createWorkerRuntime(
      config,
      fakes.dependencies,
      logger
    );

    await fakes.evidenceResumeHandler?.();

    expect(logger.info).toHaveBeenCalledWith({
      event: "queue_depth_failed",
      failure: "RangeError"
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "evidence_resume_sweep" })
    );
    await runtime.stop();
  });

  it("releases abandoned runs before it resumes waiting ones", async () => {
    // Load-bearing ordering, not housekeeping: a character freed by recovery
    // is only resumable once its dead run is out of the active set, so
    // resuming first would always leave it to the following tick.
    const fakes = runtimeFakes();
    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    await fakes.evidenceResumeHandler?.();

    expect(fakes.sweepOrder).toEqual(["listActive", "listResumable"]);
    await runtime.stop();
  });

  it("still resumes waiting runs when recovery throws", async () => {
    // Break caught: the resume queue retries once and then gives up, so an
    // unguarded recovery failure would stop every character being resumed and
    // show up only as a log line that quietly stopped appearing.
    const fakes = runtimeFakes();
    fakes.listActive.mockRejectedValueOnce(new RangeError("boom"));
    fakes.resumable.push({ region: "eu", realm: "silvermoon", name: "ryii" });
    fakes.evidenceReserve.mockResolvedValue({
      kind: "reserved",
      run: { id: "00000000-0000-4000-8000-000000000041" }
    });
    const logger = { info: vi.fn() };
    const runtime = await createWorkerRuntime(
      config,
      fakes.dependencies,
      logger
    );

    await fakes.evidenceResumeHandler?.();

    expect(fakes.evidenceMarkEnqueued).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith({
      event: "evidence_recovery_failed",
      failure: "RangeError"
    });
    await runtime.stop();
  });

  it("reports what each sweep released, republished and resumed", async () => {
    const fakes = runtimeFakes();
    fakes.activeEvidenceRuns.push({
      runId: "00000000-0000-4000-8000-000000000042",
      key: { region: "eu" as const, realm: "silvermoon", name: "adeline" },
      queueJobId: "00000000-0000-4000-8000-000000000043",
      startedAt: new Date(Date.now() - 20 * 60_000),
      createdAt: new Date(Date.now() - 21 * 60_000)
    });
    fakes.settledEvidenceJobs.push("00000000-0000-4000-8000-000000000043");
    const logger = { info: vi.fn() };
    const runtime = await createWorkerRuntime(
      config,
      fakes.dependencies,
      logger
    );

    await fakes.evidenceResumeHandler?.();

    expect(logger.info).toHaveBeenCalledWith({
      event: "evidence_resume_sweep",
      resumed: 0,
      released: 1,
      republished: 0,
      durationMs: expect.any(Number)
    });
    await runtime.stop();
  });

  // Every reading of the injected clock advances 25ms, so a cycle that reads
  // it once at the start and once for its record reports exactly 25.
  function steppingClock() {
    let now = 0;
    return () => (now += 25);
  }

  it("times each resume sweep and names the error of one that fails", async () => {
    // Break caught (#507): a slow sweep that delayed the next five-minute tick
    // was invisible, and a failed one logged nothing at all before the queue
    // retried it.
    const fakes = runtimeFakes();
    const logger = { info: vi.fn() };
    const runtime = await createWorkerRuntime(
      config,
      { ...fakes.dependencies, clock: steppingClock() },
      logger
    );

    await fakes.evidenceResumeHandler?.();
    fakes.listResumable.mockRejectedValueOnce(new TypeError("private-value"));
    await expect(fakes.evidenceResumeHandler?.()).rejects.toThrow(TypeError);

    const sweeps = logger.info.mock.calls
      .map(([record]) => record)
      .filter((record) => record.event === "evidence_resume_sweep");
    expect(sweeps).toEqual([
      {
        event: "evidence_resume_sweep",
        resumed: 0,
        released: 0,
        republished: 0,
        durationMs: 25
      },
      {
        event: "evidence_resume_sweep",
        released: 0,
        republished: 0,
        durationMs: 25,
        errorName: "TypeError"
      }
    ]);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(
      "private-value"
    );
    await runtime.stop();
  });

  it("times the hourly cleanup across the whole cycle and names a failure", async () => {
    // Break caught (#507): the cleanup record carried counts but no duration,
    // and a cycle that threw logged nothing before its retry.
    const fakes = runtimeFakes();
    const logger = { info: vi.fn() };
    const runtime = await createWorkerRuntime(
      config,
      { ...fakes.dependencies, clock: steppingClock() },
      logger
    );

    await fakes.maintenanceHandler?.();
    fakes.cleanup.evidenceRunCosts.mockRejectedValueOnce(
      new RangeError("private-value")
    );
    await expect(fakes.maintenanceHandler?.()).rejects.toThrow(RangeError);

    const cleanups = logger.info.mock.calls
      .map(([record]) => record)
      .filter((record) => record.event === "evidence_cache_cleanup");
    expect(cleanups).toEqual([
      {
        event: "evidence_cache_cleanup",
        removedEvidenceRuns: 6,
        removedCollectionStages: expect.any(Number),
        removedRunCosts: 7,
        durationMs: 25
      },
      // What had been removed before the failure is still reported.
      expect.objectContaining({
        event: "evidence_cache_cleanup",
        removedEvidenceRuns: 6,
        removedRunCosts: undefined,
        durationMs: 25,
        errorName: "RangeError"
      })
    ]);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(
      "private-value"
    );
    await runtime.stop();
  });

  it("writes one timed record per fingerprint admission, however it ends", async () => {
    // Break caught (#507): a successful admission logged nothing, so the only
    // sign the cycle ran at all was a run blocked for fifteen minutes.
    const fakes = runtimeFakes();
    const waitingRunId = "00000000-0000-4000-8000-000000000051";
    const brokenRunId = "00000000-0000-4000-8000-000000000052";
    const admitWaiting = fakes.repositories.fingerprintSweeps.admitWaiting;
    fakes.repositories.fingerprintSweeps.admitWaiting = async (runId, at) => {
      if (runId === brokenRunId) throw new SyntaxError(brokenRunId);
      return admitWaiting(runId, at);
    };
    const logger = { info: vi.fn() };
    const runtime = await createWorkerRuntime(
      config,
      { ...fakes.dependencies, clock: steppingClock() },
      logger
    );

    // A waiting run throws only to schedule its retry: not a failure.
    await expect(fakes.admissionHandler?.(waitingRunId)).rejects.toMatchObject({
      retryable: true
    });
    await expect(fakes.admissionHandler?.(brokenRunId)).rejects.toThrow(
      SyntaxError
    );

    const admissions = logger.info.mock.calls
      .map(([record]) => record)
      .filter((record) => record.event === "fingerprint_admission");
    expect(admissions).toEqual([
      { event: "fingerprint_admission", outcome: "waiting", durationMs: 25 },
      {
        event: "fingerprint_admission",
        durationMs: 25,
        errorName: "SyntaxError"
      }
    ]);
    // Neither the run id nor the error message reaches a record.
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(brokenRunId);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(waitingRunId);
    await runtime.stop();
  });

  const applicantConfig: WorkerConfig = {
    ...config,
    applicantWatcher: {
      ...config.applicantWatcher,
      enabled: true,
      sheetId: "applicant-sheet",
      apiKey: "applicant-sheet-key"
    }
  };
  const applicantGateway = () =>
    ({
      getRateLimit: vi.fn(),
      resolveCharacterById: vi.fn()
    }) as unknown as Pick<
      WarcraftLogsGateway,
      "getFirstKillReports" | "getRateLimit" | "resolveCharacterById"
    >;
  const applicantRecords = (logger: { info: ReturnType<typeof vi.fn> }) =>
    logger.info.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .filter((record) => String(record.event).startsWith("applicant_sheet"));

  it("times the applicant sheet poll and drain", async () => {
    // Break caught (#507): the poll and drain logged counts but no duration,
    // so a slow Sheet read that held up the resume tick could not be seen.
    // The stepping clock is read at the sweep, the tick, the poll and the
    // drain, each start and record 25ms apart.
    vi.mocked(pollApplicantSheet).mockResolvedValueOnce({
      baseline: false,
      created: 0,
      backlog: 0,
      invalid: 0,
      truncated: 0,
      newApplicants: []
    });
    vi.mocked(drainApplicantIntents).mockResolvedValueOnce({
      admitted: 1,
      suppressed: 0,
      deferred: 0
    });
    const fakes = runtimeFakes();
    const logger = { info: vi.fn() };
    const runtime = await createWorkerRuntime(
      applicantConfig,
      {
        ...fakes.dependencies,
        createEvidenceGateway: applicantGateway,
        clock: steppingClock()
      },
      logger
    );

    await fakes.evidenceResumeHandler?.();

    expect(applicantRecords(logger)).toEqual([
      {
        event: "applicant_sheet_poll",
        baseline: false,
        created: 0,
        backlog: 0,
        invalid: 0,
        truncated: 0,
        durationMs: 25
      },
      {
        event: "applicant_sheet_drain",
        admitted: 1,
        suppressed: 0,
        deferred: 0,
        durationMs: 25
      }
    ]);
    await runtime.stop();
  });

  it("times and names a failed applicant poll and a failed tick", async () => {
    // Break caught (#507): a failed poll said only how many times it had
    // failed, and a failed tick said nothing but that it failed -- not what
    // threw, nor how long it ran first.
    vi.mocked(pollApplicantSheet).mockRejectedValueOnce(
      new TypeError("private-value")
    );
    vi.mocked(drainApplicantIntents).mockRejectedValueOnce(
      new RangeError("private-value")
    );
    const fakes = runtimeFakes();
    const logger = { info: vi.fn() };
    const runtime = await createWorkerRuntime(
      applicantConfig,
      {
        ...fakes.dependencies,
        createEvidenceGateway: applicantGateway,
        clock: steppingClock()
      },
      logger
    );

    await fakes.evidenceResumeHandler?.();

    expect(applicantRecords(logger)).toEqual([
      {
        event: "applicant_sheet_poll_failed",
        failures: 1,
        durationMs: 25,
        errorName: "TypeError"
      },
      // Timed from the start of the tick: the due check, the failed poll and
      // the drain that threw.
      {
        event: "applicant_sheet_tick_failed",
        durationMs: 100,
        errorName: "RangeError"
      }
    ]);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(
      "private-value"
    );
    await runtime.stop();
  });

  it("completes an abandoned run from its staged scan, and says so in counts alone", async () => {
    // The whole point of #312: the stage is the finished history scan, which
    // is most of what the run cost. It is also the first thing recovery reads
    // a character key for, so the record it writes is worth pinning -- counts
    // only, never the key.
    const fakes = runtimeFakes();
    fakes.activeEvidenceRuns.push({
      runId: "00000000-0000-4000-8000-000000000044",
      key: {
        region: "eu" as const,
        realm: "silvermoon",
        name: "private-value"
      },
      queueJobId: "00000000-0000-4000-8000-000000000045",
      startedAt: new Date(Date.now() - 20 * 60_000),
      createdAt: new Date(Date.now() - 21 * 60_000)
    });
    fakes.settledEvidenceJobs.push("00000000-0000-4000-8000-000000000045");
    fakes.stagedCollection.mockResolvedValue({
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      retryAfterAt: null,
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: new Date(Date.now() - 19 * 60_000).toISOString(),
      troubledRaidIds: { parses: [], tierBests: [] }
    });
    const logger = { info: vi.fn() };
    const runtime = await createWorkerRuntime(
      config,
      fakes.dependencies,
      logger
    );

    await fakes.evidenceResumeHandler?.();

    expect(logger.info).toHaveBeenCalledWith({
      event: "evidence_resume_sweep",
      resumed: 0,
      released: 0,
      republished: 1,
      durationMs: expect.any(Number)
    });
    expect(fakes.releaseAbandoned).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(
      "private-value"
    );
    await runtime.stop();
  });

  it("frees a character orphaned at reservation within minutes", async () => {
    // Nothing ever touched this run, so the long backstop buys nothing and
    // would hide the character for most of a working day.
    const fakes = runtimeFakes();
    fakes.activeEvidenceRuns.push(
      {
        runId: "00000000-0000-4000-8000-000000000033",
        key: { region: "eu" as const, realm: "silvermoon", name: "adeline" },
        queueJobId: null,
        startedAt: null,
        createdAt: new Date(Date.now() - 60_000)
      },
      {
        runId: "00000000-0000-4000-8000-000000000034",
        key: { region: "eu" as const, realm: "silvermoon", name: "adeline" },
        queueJobId: null,
        startedAt: null,
        createdAt: new Date(Date.now() - 30 * 60_000)
      }
    );
    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    await fakes.evidenceResumeHandler?.();

    expect(fakes.releaseAbandoned).toHaveBeenCalledWith([
      "00000000-0000-4000-8000-000000000034"
    ]);
    await runtime.stop();
  });

  it("holds a claimed run whose job id was never recorded to the long backstop", async () => {
    // `markEnqueued` requires status `queued`, so a worker claiming before the
    // enqueuing process writes the id leaves a running run with no job id. The
    // orphan cutoff must not reach it: the claim guard would stop the next
    // claim, but the attempt already collecting would lose its whole scan.
    const fakes = runtimeFakes();
    fakes.activeEvidenceRuns.push(
      {
        runId: "00000000-0000-4000-8000-000000000035",
        key: { region: "eu" as const, realm: "silvermoon", name: "adeline" },
        queueJobId: null,
        startedAt: new Date(Date.now() - 40 * 60_000),
        createdAt: new Date(Date.now() - 41 * 60_000)
      },
      {
        runId: "00000000-0000-4000-8000-000000000036",
        key: { region: "eu" as const, realm: "silvermoon", name: "adeline" },
        queueJobId: null,
        startedAt: new Date(Date.now() - 9 * 60 * 60_000),
        createdAt: new Date(Date.now() - 9 * 60 * 60_000)
      }
    );
    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    await fakes.evidenceResumeHandler?.();

    expect(fakes.releaseAbandoned).toHaveBeenCalledWith([
      "00000000-0000-4000-8000-000000000036"
    ]);
    await runtime.stop();
  });

  it("enqueues nothing when no character is waiting", async () => {
    const fakes = runtimeFakes();
    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    await fakes.evidenceResumeHandler?.();

    expect(fakes.evidenceReserve).not.toHaveBeenCalled();
    expect(fakes.evidenceMarkEnqueued).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("recovers reservations left pending before registering workers", async () => {
    // Break caught: a web-process crash before enqueue could strand a charged queued run.
    const fakes = runtimeFakes();
    fakes.pendingDispatches.push({
      runId: "00000000-0000-4000-8000-000000000011",
      key: { region: "eu", realm: "silvermoon", name: "pending" }
    });

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    // A recovered job gets a fresh enqueuedAt (not the original, since there
    // is none stored) so it measures its new wait rather than a stale one.
    expect(fakes.enqueued).toEqual([
      expect.objectContaining({
        ...fakes.pendingDispatches[0],
        enqueuedAt: expect.any(String)
      })
    ]);
    expect(fakes.recoveredDispatches).toEqual([
      "00000000-0000-4000-8000-000000000011"
    ]);
    await runtime.stop();
  });

  it("registers the private admission worker and re-enqueues only admitted discovery runs", async () => {
    // Break caught: waiting fingerprint sweeps could consume discovery delivery attempts before budget admission.
    const fakes = runtimeFakes();
    const waitingRunId = "00000000-0000-4000-8000-000000000012";
    const key = { region: "eu" as const, realm: "silvermoon", name: "waiting" };
    fakes.waitingFingerprintRuns.push(waitingRunId);
    fakes.admittedFingerprintRuns.add(waitingRunId);
    const existingRun = {
      id: waitingRunId,
      rootKey: key,
      rootCharacterId: null,
      queueJobId: null,
      status: "queued" as const,
      callerClass: "anonymous" as const,
      attempt: 0,
      nextRetryAt: null,
      errorCode: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      snapshotId: null
    };
    fakes.repositories.runs = {
      async find(runId: string) {
        return runId === waitingRunId ? existingRun : null;
      }
    } as Repositories["runs"];

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    expect(fakes.fingerprintAdmissions).toEqual([waitingRunId]);
    expect(fakes.admissionHandler).toBeTypeOf("function");
    await fakes.admissionHandler?.(waitingRunId);
    expect(fakes.enqueued).toEqual([
      { runId: waitingRunId, key, enqueuedAt: expect.any(String) }
    ]);
    expect(fakes.handler.execute).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("keeps a budget-blocked fingerprint run out of discovery work", async () => {
    // Break caught: a waiting admission could be redispatched into a discovery worker before capacity exists.
    const fakes = runtimeFakes();
    const waitingRunId = "00000000-0000-4000-8000-000000000013";
    fakes.waitingFingerprintRuns.push(waitingRunId);

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    await expect(fakes.admissionHandler?.(waitingRunId)).rejects.toMatchObject({
      retryable: true
    });
    expect(fakes.enqueued).toEqual([]);
    expect(fakes.handler.execute).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("recovers an admitted fingerprint run that was not durably dispatched", async () => {
    // Break caught: a process failure between admission and enqueue could strand a reserved sweep forever.
    const fakes = runtimeFakes();
    const runId = "00000000-0000-4000-8000-000000000014";
    const key = {
      region: "eu" as const,
      realm: "silvermoon",
      name: "admitted"
    };
    fakes.admittedUndispatchedFingerprintRuns.push(runId);
    fakes.repositories.runs = {
      async find(id: string) {
        return id === runId
          ? {
              id: runId,
              rootKey: key,
              rootCharacterId: null,
              queueJobId: null,
              status: "queued" as const,
              callerClass: "anonymous" as const,
              attempt: 0,
              nextRetryAt: null,
              errorCode: null,
              createdAt: new Date(),
              startedAt: null,
              completedAt: null,
              snapshotId: null
            }
          : null;
      }
    } as Repositories["runs"];

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    expect(fakes.enqueued).toEqual([
      { runId, key, enqueuedAt: expect.any(String) }
    ]);
    expect(fakes.dispatchedFingerprintRuns).toEqual([runId]);
    await runtime.stop();
  });

  it("dispatches a run with a stored cursor as a continuation", async () => {
    // Break caught: a resumed sweep could re-dispatch as an ordinary job,
    // sending the handler down the fresh-start path instead of resuming from
    // its stored cursor.
    const fakes = runtimeFakes();
    const runId = "00000000-0000-4000-8000-000000000015";
    const key = {
      region: "eu" as const,
      realm: "draenor",
      name: "valadares"
    };
    fakes.admittedUndispatchedFingerprintRuns.push(runId);
    fakes.repositories.runs = {
      async find(id: string) {
        return id === runId
          ? {
              id: runId,
              rootKey: key,
              rootCharacterId: null,
              queueJobId: null,
              status: "queued" as const,
              callerClass: "anonymous" as const,
              attempt: 0,
              nextRetryAt: null,
              errorCode: null,
              createdAt: new Date(),
              startedAt: null,
              completedAt: null,
              snapshotId: null
            }
          : null;
      }
    } as Repositories["runs"];
    fakes.setResumeState({
      resumeAfter: JSON.stringify(["eu", "draenor", "valadares"]),
      snapshotId: "snapshot-1",
      runId,
      limitationCode: null
    });

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    expect(fakes.enqueued).toEqual([
      expect.objectContaining({ runId, continuation: true })
    ]);
    await runtime.stop();
  });

  it("dispatches a run with no cursor as an ordinary job", async () => {
    // Break caught: every admitted dispatch could be marked as a continuation
    // regardless of whether a cursor exists, sending fresh sweeps down the
    // resume path they have no state for.
    const fakes = runtimeFakes();
    const runId = "00000000-0000-4000-8000-000000000016";
    const key = {
      region: "eu" as const,
      realm: "silvermoon",
      name: "fresh"
    };
    fakes.admittedUndispatchedFingerprintRuns.push(runId);
    fakes.repositories.runs = {
      async find(id: string) {
        return id === runId
          ? {
              id: runId,
              rootKey: key,
              rootCharacterId: null,
              queueJobId: null,
              status: "queued" as const,
              callerClass: "anonymous" as const,
              attempt: 0,
              nextRetryAt: null,
              errorCode: null,
              createdAt: new Date(),
              startedAt: null,
              completedAt: null,
              snapshotId: null
            }
          : null;
      }
    } as Repositories["runs"];
    fakes.setResumeState(null);

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    expect(fakes.enqueued[0]).not.toHaveProperty("continuation");
    await runtime.stop();
  });

  it("dispatches a run that does not own the cursor as an ordinary job", async () => {
    // Break caught: the dispatcher asked whether the ROOT had a cursor, never
    // whether this RUN owned it. A fresh refresh for a root with a live chain
    // went out as a continuation: it skipped Raider.IO discovery entirely,
    // amended another run's snapshot, and never completed itself, so the
    // visitor's refresh hung forever.
    const fakes = runtimeFakes();
    const runId = "00000000-0000-4000-8000-000000000018";
    const key = {
      region: "eu" as const,
      realm: "draenor",
      name: "refreshed"
    };
    fakes.admittedUndispatchedFingerprintRuns.push(runId);
    fakes.repositories.runs = {
      async find(id: string) {
        return id === runId
          ? {
              id: runId,
              rootKey: key,
              rootCharacterId: null,
              queueJobId: null,
              status: "queued" as const,
              callerClass: "anonymous" as const,
              attempt: 0,
              nextRetryAt: null,
              errorCode: null,
              createdAt: new Date(),
              startedAt: null,
              completedAt: null,
              snapshotId: null
            }
          : null;
      }
    } as Repositories["runs"];
    // The cursor belongs to an earlier run of the same root.
    fakes.setResumeState({
      resumeAfter: JSON.stringify(["eu", "draenor", "valadares"]),
      snapshotId: "snapshot-1",
      runId: "00000000-0000-4000-8000-000000000019",
      limitationCode: null
    });

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    expect(fakes.enqueued).toEqual([
      { runId, key, enqueuedAt: expect.any(String) }
    ]);
    await runtime.stop();
  });

  it("threads the job payload through to the discovery handler", async () => {
    // Break caught: the worker could stop passing the job payload to the
    // handler, leaving a resumed handler with no cursor to resume from even
    // though the queue dispatched it as a continuation.
    const fakes = runtimeFakes();

    const runtime = await createWorkerRuntime(config, fakes.dependencies);
    const payload = {
      runId: "00000000-0000-4000-8000-000000000017",
      key: { region: "eu" as const, realm: "draenor", name: "valadares" },
      enqueuedAt: "2026-09-13T12:00:00.000Z",
      continuation: true as const
    };
    const context = {
      attempt: 1,
      maxAttempts: 5,
      signal: new AbortController().signal
    };

    await fakes.workHandler?.(payload, context);

    expect(fakes.handler.execute).toHaveBeenCalledWith(
      payload.runId,
      {
        ...context,
        correlationId: undefined,
        enqueuedAt: payload.enqueuedAt
      },
      payload
    );
    await runtime.stop();
  });

  it("recovers every waiting fingerprint admission before readiness", async () => {
    // Break caught: a fixed recovery batch could strand the 101st durable admission after a restart.
    const fakes = runtimeFakes();
    fakes.waitingFingerprintRuns.push(
      ...Array.from(
        { length: 101 },
        (_unused, index) =>
          `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`
      )
    );

    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    expect(fakes.fingerprintAdmissions).toEqual(fakes.waitingFingerprintRuns);
    await runtime.stop();
  });

  it("drops readiness before gracefully draining and closing PostgreSQL", async () => {
    // Break caught: shutdown could close storage under an in-flight job.
    const fakes = runtimeFakes();
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const stop = vi.fn(async () => {
      await drain;
    });
    fakes.queue.stop = stop;
    const runtime = await createWorkerRuntime(config, fakes.dependencies);

    const stopping = runtime.stop();
    await expect(runtime.health()).resolves.toEqual({
      live: true,
      ready: false
    });
    expect(stop).toHaveBeenCalledWith({
      graceful: true,
      timeoutMs: 12_345,
      abortGraceMs: 5_000
    });
    expect(fakes.ended).toBe(false);
    releaseDrain();
    await stopping;
    expect(fakes.ended).toBe(true);
  });

  it("propagates a queue settlement timeout without awaiting a blocked pool close", async () => {
    // Break caught: runtime could reintroduce an unbounded wait after queue timeout.
    const fakes = runtimeFakes();
    const stopError = new DiscoveryQueueStopTimeoutError();
    fakes.queue.stop = async () => {
      throw stopError;
    };
    let releasePool!: () => void;
    const blockedPool = new Promise<void>((resolve) => {
      releasePool = resolve;
    });
    fakes.dependencies.createPool = () => ({
      async query() {
        return { rows: [{ "?column?": 1 }] };
      },
      async end() {
        await blockedPool;
      }
    });
    const runtime = await createWorkerRuntime(config, fakes.dependencies);
    const stopping = runtime.stop();

    try {
      const result = await Promise.race([
        stopping.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error })
        ),
        new Promise<{ kind: "pending" }>((resolve) =>
          setTimeout(() => resolve({ kind: "pending" }), 50)
        )
      ]);
      expect(result).toEqual({ kind: "rejected", error: stopError });
    } finally {
      releasePool();
      await stopping.catch(() => undefined);
    }
  });

  it("fails after the bounded startup attempt count", async () => {
    // Break caught: startup could retry forever and stay deceptively live.
    const fakes = runtimeFakes();
    fakes.dependencies.createPool = () => ({
      async query() {
        throw new Error("database_starting");
      },
      async end() {}
    });

    await expect(
      createWorkerRuntime(config, fakes.dependencies)
    ).rejects.toThrow("database_starting");
    expect(fakes.sleeps).toEqual([10, 20]);
  });

  it("closes queue and database resources when initialization fails", async () => {
    // Break caught: a failed work registration could leak pg-boss and PostgreSQL pools.
    const fakes = runtimeFakes();
    const stop = vi.fn(async () => {});
    fakes.queue.stop = stop;
    fakes.queue.work = async () => {
      throw new Error("work_registration_failed");
    };

    await expect(
      createWorkerRuntime(config, fakes.dependencies)
    ).rejects.toThrow("work_registration_failed");

    expect(stop).toHaveBeenCalledWith({
      graceful: false,
      timeoutMs: 12_345
    });
    expect(fakes.ended).toBe(true);
  });
});

describe("createRaiderIoGateway", () => {
  function jsonFetchMock() {
    return vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ name: "Sentinel" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
  }

  it("keeps the configured access key off the worker's unofficial requests", async () => {
    // Break caught: forwarding the worker's configured key onto character-page
    // endpoints makes Raider.IO reject otherwise valid discovery requests.
    const fetchMock = jsonFetchMock();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    try {
      const gateway = createRaiderIoGateway({
        ...config,
        raiderIoAccessKey: "server-key"
      });
      await gateway
        .getCharacter({ region: "eu", realm: "silvermoon", name: "sentinel" })
        .catch(() => undefined);

      const url = new URL((fetchMock.mock.calls[0]![0] as URL).toString());
      expect(url.pathname).toBe("/api/characters/eu/silvermoon/sentinel");
      expect(url.searchParams.has("access_key")).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("sends no access_key parameter when no key is configured", async () => {
    // Break caught: an unset key could be attached as an empty parameter,
    // breaking anonymous access for local dev and contributors without a key.
    const fetchMock = jsonFetchMock();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    try {
      const gateway = createRaiderIoGateway(config);
      await gateway
        .getCharacter({ region: "eu", realm: "silvermoon", name: "sentinel" })
        .catch(() => undefined);

      const url = new URL((fetchMock.mock.calls[0]![0] as URL).toString());
      expect(url.searchParams.has("access_key")).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

it("starts and drains configured account mail delivery alongside evidence work", async () => {
  const fake = runtimeFakes();
  const stopMail = vi.fn(async () => {
    expect(fake.ended).toBe(false);
  });
  const startAccountMailWorker = vi.fn(() => ({ stop: stopMail }));
  const accountMail = {
    resendApiKey: "secret",
    accountEmailFrom: "accounts@example.com",
    accountCredentialEncryptionKey: Buffer.alloc(32, 7)
  };
  const runtime = await createWorkerRuntime(
    { ...config, accountMail },
    { ...fake.dependencies, startAccountMailWorker }
  );
  expect(startAccountMailWorker).toHaveBeenCalledWith(
    fake.repositories.accountMail,
    accountMail,
    undefined
  );
  expect(await runtime.health()).toEqual({ live: true, ready: true });
  await runtime.stop();
  expect(stopMail).toHaveBeenCalledOnce();
});

it.each(["claim", "ack"] as const)(
  "bounds shutdown with a stalled mail %s and starts evidence shutdown promptly",
  async (stage) => {
    vi.useFakeTimers();
    const fake = runtimeFakes();
    const blocked = new Promise<never>(() => undefined);
    fake.repositories.accountMail = {
      issue: vi.fn(),
      claimDue: vi.fn(async () =>
        stage === "claim"
          ? blocked
          : {
              id: "mail",
              idempotencyKey: "mail",
              encryptedMessage: encryptAccountMail("{}", Buffer.alloc(32, 7)),
              attempt: 1,
              expiresAt: new Date(Date.now() + 60000)
            }
      ),
      markSent: vi.fn(() => blocked)
    };
    vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
    const queueStop = vi.spyOn(fake.queue, "stop");
    const runtime = await createWorkerRuntime(
      {
        ...config,
        workerDrainTimeoutMs: 100,
        accountMail: {
          resendApiKey: "key",
          accountEmailFrom: "a@example.com",
          accountCredentialEncryptionKey: Buffer.alloc(32, 7)
        }
      },
      fake.dependencies
    );
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(
        stage === "claim"
          ? fake.repositories.accountMail.claimDue
          : fake.repositories.accountMail.markSent
      ).toHaveBeenCalled();
      let result: unknown;
      const stopping = runtime.stop().catch((error) => {
        result = error;
      });
      expect(queueStop).toHaveBeenCalledOnce();
      expect(fake.ended).toBe(false);
      await vi.advanceTimersByTimeAsync(101);
      await stopping;
      expect(result).toMatchObject({ message: "account_mail_stop_timed_out" });
      expect(fake.ended).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  }
);
