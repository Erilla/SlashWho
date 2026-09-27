import {
  applicantDossierSchema,
  safeApiErrorSchema,
  type ApplicantDossier
} from "@slashwho/contracts";
import type { MeasurementScope } from "@slashwho/application";
import { beforeEach, describe, expect, it, vi } from "vitest";

const characterUrl =
  "https://www.warcraftlogs.com/character/eu/silvermoon/ryii";
const jobId = "54f14e37-7df7-43db-91d5-21e797d1d145";

const dossier = applicantDossierSchema.parse({
  root: { region: "eu", realm: "silvermoon", name: "ryii" },
  research: {
    state: "complete",
    message: "Linked-character research is complete."
  },
  characters: [
    {
      key: { region: "eu", realm: "silvermoon", name: "ryii" },
      displayName: "Ryii",
      className: "Mage",
      raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
      source: "raiderio_declared"
    }
  ],
  raids: [],
  cuttingEdges: [],
  limitations: []
});

let started: unknown;
let read: { kind: "ready"; dossier: ApplicantDossier } | { kind: "not_ready" };
let readInitial:
  { kind: "ready"; dossier: ApplicantDossier } | { kind: "not_ready" };
let readAllowed:
  { allowed: true } | { allowed: false; retryAfterSeconds: number };
let readCalls = 0;
let readInitialCalls = 0;
let lastReadOverrides: unknown;
let lastReadScope: MeasurementScope | undefined;
let signedInAccount: string | null = null;
let progressCalls: string[][] = [];
let passwordChangeRequired = false;

const dossiers = {
  async start() {
    return started;
  },
  async read(
    _key: unknown,
    _signal: unknown,
    overrides: unknown,
    scope: MeasurementScope
  ) {
    readCalls += 1;
    lastReadOverrides = overrides;
    lastReadScope = scope;
    return read;
  },
  async readInitial(_key: unknown, _signal: unknown, overrides: unknown) {
    readInitialCalls += 1;
    void overrides;
    return readInitial;
  },
  async readEvidenceRunProgress(ids: string[]) {
    progressCalls.push(ids);
    return ids.map((id) => ({
      id,
      state: "running" as const,
      version: "running:active"
    }));
  }
};

const searches = {
  async authorizePublicRead() {
    return readAllowed;
  },
  async getRun() {
    return {
      jobId,
      status: "queued" as const,
      characterUrl: "/characters/eu/silvermoon/ryii",
      createdAt: "2026-09-11T12:00:00.000Z",
      startedAt: null,
      completedAt: null,
      retryAt: null,
      error: null
    };
  }
};

vi.mock("../../../server/container", () => ({
  getContainer: async () => ({
    dossiers,
    searches,
    accountAuth: {
      authenticate: async () => ({
        principal: signedInAccount
          ? {
              kind: "account",
              accountId: signedInAccount,
              passwordChangeRequired
            }
          : null
      })
    },
    accountCredentials: {
      resolve: async (accountId: string, provider: string) =>
        provider === "warcraftlogs"
          ? {
              values: {
                clientId: `${accountId}-id`,
                clientSecret: `${accountId}-key`
              },
              version: 2
            }
          : null
    }
  })
}));

vi.mock("../../../server/config", () => ({
  loadWebConfig: () => ({
    databaseUrl: "postgresql://slashwho:secret@db.internal/slashwho",
    application: {
      PUBLIC_READS_PER_MINUTE: 60,
      BOT_API_KEY: "b".repeat(32),
      RATE_LIMIT_HASH_SECRET: "r".repeat(32)
    },
    dossier: {
      raiderIoBaseUrl: "https://raider.io",
      raiderIoTimeoutMs: 10_000,
      blizzardClientId: "blizzard-client-id",
      blizzardClientSecret: "blizzard-client-secret",
      evidenceJobCredentialEncryptionKey: Buffer.alloc(32)
    }
  })
}));

import { POST } from "./route";
import { GET } from "./[region]/[realm]/[name]/route";
import { GET as GET_JOB } from "./jobs/[jobId]/route";
import { GET as GET_EVIDENCE_RUNS } from "./evidence-runs/route";

function dossierRequest(body: unknown): Request {
  return new Request("https://slashwho.example/api/dossiers", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.8" },
    body: JSON.stringify(body)
  });
}

const characterContext = {
  params: Promise.resolve({ region: "eu", realm: "silvermoon", name: "ryii" })
};
const noncanonicalCharacterContext = {
  params: Promise.resolve({ region: "EU", realm: "Silvermoon", name: "Ryii" })
};

beforeEach(() => {
  signedInAccount = null;
  passwordChangeRequired = false;
  started = {
    kind: "job",
    jobId,
    status: "queued",
    staleCharacter: null
  };
  read = { kind: "ready", dossier };
  readInitial = {
    kind: "ready",
    dossier: applicantDossierSchema.parse({
      ...dossier,
      research: {
        state: "initial",
        message:
          "Linked-character research is still running; this evidence covers only the submitted character."
      }
    })
  };
  readAllowed = { allowed: true };
  readCalls = 0;
  readInitialCalls = 0;
  lastReadOverrides = undefined;
  progressCalls = [];
  lastReadScope = undefined;
});

describe("POST /api/dossiers", () => {
  it("starts or reuses discovery for a valid applicant identity", async () => {
    // Break caught: a Warcraft Logs identity could fail to receive a pollable
    // discovery response from the dossier endpoint.
    const response = await POST(dossierRequest({ characterUrl }));
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(
      `/api/dossiers/jobs/${jobId}`
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      kind: "job",
      jobId
    });
  });

  it("returns a safe validation error without reflecting supplied input", async () => {
    // Break caught: malformed applicant URLs could echo private request data.
    const marker = "private-marker-dossier";
    const response = await POST(dossierRequest({ characterUrl: marker }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(safeApiErrorSchema.parse(body).error.code).toBe(
      "invalid_character_url"
    );
    expect(JSON.stringify(body)).not.toContain(marker);
  });
});

describe("GET /api/dossiers/:region/:realm/:name", () => {
  it("preserves the recognized initial scope when redirecting to a canonical identity", async () => {
    // Break caught: a canonical redirect could silently turn a root-only read
    // into an expanded snapshot-backed read.
    const response = await GET(
      new Request(
        "https://slashwho.example/api/dossiers/EU/Silvermoon/Ryii?scope=initial",
        { headers: { "x-real-ip": "203.0.113.8" } }
      ),
      noncanonicalCharacterContext
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "/api/dossiers/eu/silvermoon/ryii?scope=initial"
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readInitialCalls).toBe(0);
    expect(readCalls).toBe(0);
  });

  it("uses only the initial dossier read after authorizing an initial request", async () => {
    // Break caught: initial evidence could wait for a relationship snapshot or
    // bypass the public-read admission that protects third-party evidence calls.
    const response = await GET(
      new Request(
        "https://slashwho.example/api/dossiers/eu/silvermoon/ryii?scope=initial",
        { headers: { "x-real-ip": "203.0.113.8" } }
      ),
      characterContext
    );

    expect(response.status).toBe(200);
    expect(readInitialCalls).toBe(1);
    expect(readCalls).toBe(0);
    expect(
      applicantDossierSchema.parse(await response.json()).research.state
    ).toBe("initial");
  });

  it("keeps unknown scopes on the expanded dossier read", async () => {
    // Break caught: a misspelled or future scope could accidentally receive
    // root-only evidence and present it as the snapshot-backed dossier.
    const response = await GET(
      new Request(
        "https://slashwho.example/api/dossiers/eu/silvermoon/ryii?scope=expanded",
        { headers: { "x-real-ip": "203.0.113.8" } }
      ),
      characterContext
    );

    expect(response.status).toBe(200);
    expect(readCalls).toBe(1);
    expect(readInitialCalls).toBe(0);
    expect(
      applicantDossierSchema.parse(await response.json()).research.state
    ).toBe("complete");
  });

  it("returns a strict applicant dossier after admitting the public read", async () => {
    // Break caught: a route could return unvalidated evidence material to the browser.
    const response = await GET(
      new Request("https://slashwho.example/api/dossiers/eu/silvermoon/ryii", {
        headers: { "x-real-ip": "203.0.113.8" }
      }),
      characterContext
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(applicantDossierSchema.parse(await response.json())).toEqual(
      dossier
    );
  });

  it("times the finished dossier's validation and serialisation as respond", async () => {
    // Issue #687: compaction, validation and serialisation ran in no bucket.
    // The route times them once and the count of the body once more.
    const response = await GET(
      new Request("https://slashwho.example/api/dossiers/eu/silvermoon/ryii", {
        headers: { "x-real-ip": "203.0.113.8" }
      }),
      characterContext
    );
    expect(response.status).toBe(200);
    expect(lastReadScope?.totals()).toMatchObject({
      respondCalls: 2,
      respondMs: expect.any(Number)
    });
  });

  it("rejects rate-limited reads before gathering third-party dossier evidence", async () => {
    // Break caught: a read throttle could be applied after upstream evidence calls.
    readAllowed = { allowed: false, retryAfterSeconds: 11 };
    const response = await GET(
      new Request("https://slashwho.example/api/dossiers/eu/silvermoon/ryii", {
        headers: { "x-real-ip": "203.0.113.8" }
      }),
      characterContext
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("11");
    expect(readCalls).toBe(0);
    expect(safeApiErrorSchema.parse(await response.json()).error.code).toBe(
      "rate_limited"
    );
  });

  it("rejects rate-limited initial reads before gathering root evidence", async () => {
    // Break caught: the initial scope could bypass public-read admission and
    // spend third-party evidence calls after its rate limit is exhausted.
    readAllowed = { allowed: false, retryAfterSeconds: 11 };
    const response = await GET(
      new Request(
        "https://slashwho.example/api/dossiers/eu/silvermoon/ryii?scope=initial",
        { headers: { "x-real-ip": "203.0.113.8" } }
      ),
      characterContext
    );

    expect(response.status).toBe(429);
    expect(readInitialCalls).toBe(0);
    expect(readCalls).toBe(0);
    expect(safeApiErrorSchema.parse(await response.json()).error.code).toBe(
      "rate_limited"
    );
  });

  it("reports discovery still in progress without exposing internal details", async () => {
    // Break caught: an absent snapshot could become an opaque or unsafe server error.
    read = { kind: "not_ready" };
    const response = await GET(
      new Request("https://slashwho.example/api/dossiers/eu/silvermoon/ryii", {
        headers: { "x-real-ip": "203.0.113.8" }
      }),
      characterContext
    );
    expect(response.status).toBe(409);
    expect(safeApiErrorSchema.parse(await response.json()).error.code).toBe(
      "discovery_not_ready"
    );
  });

  it("refuses an initial read nobody searched for instead of serving it", async () => {
    // Break caught (#709): a direct `?scope=initial` call for a character no
    // search has asked about queued a full evidence collection. The service
    // withholds it, and the route must not fall back to the expanded read.
    readInitial = { kind: "not_ready" };
    const response = await GET(
      new Request(
        "https://slashwho.example/api/dossiers/eu/silvermoon/ryii?scope=initial",
        { headers: { "x-real-ip": "203.0.113.8" } }
      ),
      characterContext
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readInitialCalls).toBe(1);
    expect(readCalls).toBe(0);
    expect(safeApiErrorSchema.parse(await response.json()).error.code).toBe(
      "discovery_not_ready"
    );
  });

  it("builds a Blizzard gateway override from visitor-supplied credential headers", async () => {
    // Break caught: a visitor's own Blizzard credentials could be silently
    // dropped instead of being used for that request's evidence gathering.
    const response = await GET(
      new Request("https://slashwho.example/api/dossiers/eu/silvermoon/ryii", {
        headers: {
          "x-real-ip": "203.0.113.8",
          "x-blizzard-client-id": "visitor-id",
          "x-blizzard-client-secret": "visitor-secret"
        }
      }),
      characterContext
    );

    expect(response.status).toBe(200);
    expect(readCalls).toBe(1);
    expect(lastReadOverrides).toMatchObject({ blizzard: expect.anything() });
  });

  it("resolves each signed-in account's key despite stale browser headers", async () => {
    const request = () =>
      new Request("https://slashwho.example/api/dossiers/eu/silvermoon/ryii", {
        headers: {
          "x-real-ip": "203.0.113.8",
          "x-wcl-client-id": "stale",
          "x-wcl-client-secret": "alice-key"
        }
      });
    signedInAccount = "alice";
    await GET(request(), characterContext);
    expect(lastReadOverrides).toMatchObject({
      wclCredentialRef: { accountId: "alice", credentialVersion: 2 },
      wclCredentials: { clientSecret: "alice-key" }
    });
    signedInAccount = "bob";
    await GET(request(), characterContext);
    expect(lastReadOverrides).toMatchObject({
      wclCredentialRef: { accountId: "bob", credentialVersion: 2 },
      wclCredentials: { clientSecret: "bob-key" }
    });
  });

  it("does not reserve an account key for a restricted account", async () => {
    signedInAccount = "alice";
    passwordChangeRequired = true;
    const response = await GET(
      new Request("https://slashwho.example/api/dossiers/eu/silvermoon/ryii", {
        headers: {
          "x-real-ip": "203.0.113.8",
          "x-wcl-client-id": "stale",
          "x-wcl-client-secret": "stale-key"
        }
      }),
      characterContext
    );
    expect(response.status).toBe(200);
    expect(lastReadOverrides).toEqual({});
  });
});

describe("GET /api/dossiers/jobs/:jobId", () => {
  it("exposes only dossier research status at the dossier-scoped endpoint", async () => {
    // Break caught: in-flight dossier research could continue polling the
    // retired versioned public API or expose a character URL in its status body.
    const response = await GET_JOB(
      new Request(`https://slashwho.example/api/dossiers/jobs/${jobId}`, {
        headers: { "x-real-ip": "203.0.113.8" }
      }),
      { params: Promise.resolve({ jobId }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "queued",
      error: null
    });
  });
});

describe("GET /api/dossiers/evidence-runs", () => {
  const runId = "10000000-0000-4000-8000-000000000013";
  const otherRunId = "10000000-0000-4000-8000-000000000014";

  function progressRequest(ids: string): Request {
    return new Request(
      `https://slashwho.example/api/dossiers/evidence-runs?ids=${ids}`,
      { headers: { "x-real-ip": "203.0.113.8" } }
    );
  }

  it("reports each watched run's progress and nothing else, never cached", async () => {
    const response = await GET_EVIDENCE_RUNS(
      progressRequest(`${runId},${otherRunId.toUpperCase()},${runId}`)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      runs: [
        { id: runId, state: "running", version: "running:active" },
        { id: otherRunId, state: "running", version: "running:active" }
      ]
    });
    expect(progressCalls).toEqual([[runId, otherRunId]]);
  });

  it("refuses malformed, missing or too many ids before reading anything", async () => {
    const tooMany = Array.from(
      { length: 65 },
      (_, index) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`
    ).join(",");
    for (const ids of ["", "not-a-run", `${runId},x`, tooMany]) {
      const response = await GET_EVIDENCE_RUNS(progressRequest(ids));
      expect(response.status).toBe(404);
      expect(safeApiErrorSchema.parse(await response.json()).error.code).toBe(
        "character_not_found"
      );
    }
    expect(progressCalls).toEqual([]);
  });

  it("is admitted as a public read, like the dossier it watches", async () => {
    readAllowed = { allowed: false, retryAfterSeconds: 7 };

    const response = await GET_EVIDENCE_RUNS(progressRequest(runId));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(progressCalls).toEqual([]);
  });
});
