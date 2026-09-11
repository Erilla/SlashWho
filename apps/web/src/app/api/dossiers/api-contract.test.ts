import {
  applicantDossierSchema,
  safeApiErrorSchema,
  type ApplicantDossier
} from "@slashwho/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const characterUrl =
  "https://www.warcraftlogs.com/character/eu/silvermoon/ryii";
const jobId = "54f14e37-7df7-43db-91d5-21e797d1d145";

const dossier = applicantDossierSchema.parse({
  root: { region: "eu", realm: "silvermoon", name: "ryii" },
  characters: [
    {
      key: { region: "eu", realm: "silvermoon", name: "ryii" },
      displayName: "Ryii",
      source: "raiderio_declared"
    }
  ],
  raids: [],
  limitations: []
});

let started: unknown;
let read: { kind: "ready"; dossier: ApplicantDossier } | { kind: "not_ready" };
let readAllowed:
  { allowed: true } | { allowed: false; retryAfterSeconds: number };
let readCalls = 0;

const dossiers = {
  async start() {
    return started;
  },
  async read() {
    readCalls += 1;
    return read;
  }
};

const searches = {
  async authorizePublicRead() {
    return readAllowed;
  }
};

vi.mock("../../../server/container", () => ({
  getContainer: async () => ({ dossiers, searches })
}));

import { POST } from "./route";
import { GET } from "./[region]/[realm]/[name]/route";

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

beforeEach(() => {
  started = {
    kind: "job",
    jobId,
    status: "queued",
    statusUrl: `/api/v1/searches/${jobId}`,
    characterUrl: "/characters/eu/silvermoon/ryii",
    staleCharacter: null
  };
  read = { kind: "ready", dossier };
  readAllowed = { allowed: true };
  readCalls = 0;
});

describe("POST /api/dossiers", () => {
  it("starts or reuses discovery for a valid applicant identity", async () => {
    // Break caught: a Warcraft Logs identity could fail to receive a pollable
    // discovery response from the dossier endpoint.
    const response = await POST(dossierRequest({ characterUrl }));
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/api/v1/searches/${jobId}`);
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
});
