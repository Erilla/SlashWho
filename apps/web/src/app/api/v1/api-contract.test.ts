import {
  characterResourceSchema,
  createSearchRequestSchema,
  createSearchResponseSchema,
  historyPageSchema,
  historicalSnapshotSchema,
  jobStatusResponseSchema,
  safeApiErrorSchema,
  type CharacterResource,
  type HistoricalSnapshot,
  type HistoryPage,
  type JobStatusResponse
} from "@slashwho/contracts";
import type {
  CreateSearchResult,
  PublicReadAuthorizationResult,
  SearchService
} from "@slashwho/application";
import { beforeEach, describe, expect, it, vi } from "vitest";

import botClientFixture from "../../../../../../tests/fixtures/contracts/bot-client-v1.json";

const jobId = "54f14e37-7df7-43db-91d5-21e797d1d145";
const snapshotId = "13af3173-e97c-4c78-a6cb-a54b647b209f";
const characterUrl = "https://raider.io/characters/eu/silvermoon/ryii";

const character = characterResourceSchema.parse({
  character: {
    region: "eu",
    realm: "silvermoon",
    name: "Ryii",
    className: "Mage",
    level: 80,
    raiderIoUrl: characterUrl
  },
  snapshot: {
    id: snapshotId,
    state: "complete",
    refreshedAt: "2026-08-04T12:30:00.000Z",
    characterCount: 1,
    characters: [
      {
        region: "eu",
        realm: "silvermoon",
        name: "Ryii",
        className: "Mage",
        level: 80,
        raiderIoUrl: characterUrl
      }
    ]
  },
  activeJob: null
});

const job = jobStatusResponseSchema.parse({
  jobId,
  status: "queued",
  characterUrl: "/characters/eu/silvermoon/ryii",
  createdAt: "2026-08-04T12:00:00.000Z",
  startedAt: null,
  completedAt: null,
  retryAt: null,
  error: null
});

const history = historyPageSchema.parse({
  items: [
    {
      id: snapshotId,
      refreshedAt: "2026-08-04T12:30:00.000Z",
      state: "complete",
      characterCount: 1,
      url: `/api/v1/characters/eu/silvermoon/ryii/history/${snapshotId}`,
      characterUrl: "/characters/eu/silvermoon/ryii"
    }
  ],
  nextCursor: null
});

const historical = historicalSnapshotSchema.parse({
  id: snapshotId,
  root: character.character,
  refreshedAt: "2026-08-04T12:30:00.000Z",
  state: "complete",
  characters: [character.character]
});

let searchResult: CreateSearchResult;
let runResult: JobStatusResponse | null;
let currentResult: CharacterResource | null;
let historyResult: HistoryPage | null;
let snapshotResult: HistoricalSnapshot | null;
let readAuthorization: PublicReadAuthorizationResult;

const searches: SearchService = {
  async create() {
    return searchResult;
  },
  async authorizePublicRead() {
    return readAuthorization;
  },
  async getRun() {
    return runResult;
  },
  async getCurrent() {
    return currentResult;
  },
  async getHistory() {
    return historyResult;
  },
  async getSnapshot() {
    return snapshotResult;
  },
  async cleanupExpired() {
    return { rateLimits: 0, negativeCache: 0, suppressions: 0 };
  }
};

vi.mock("../../../server/container", () => ({
  getContainer: async () => ({ searches })
}));

import { POST } from "./searches/route";
import { GET as GET_JOB } from "./searches/[jobId]/route";
import { GET as GET_CHARACTER } from "./characters/[region]/[realm]/[name]/route";
import { GET as GET_HISTORY } from "./characters/[region]/[realm]/[name]/history/route";
import { GET as GET_SNAPSHOT } from "./characters/[region]/[realm]/[name]/history/[snapshotId]/route";

function jsonRequest(body: unknown, headers: HeadersInit = {}): Request {
  return new Request("https://slashwho.example/api/v1/searches", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": "203.0.113.8",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

const characterContext = {
  params: Promise.resolve({ region: "eu", realm: "silvermoon", name: "ryii" })
};

beforeEach(() => {
  searchResult = {
    kind: "job",
    jobId,
    status: "queued",
    statusUrl: `/api/v1/searches/${jobId}`,
    characterUrl: "/characters/eu/silvermoon/ryii",
    staleCharacter: null
  };
  runResult = job;
  currentResult = character;
  historyResult = history;
  snapshotResult = historical;
  readAuthorization = { allowed: true };
});

describe("POST /api/v1/searches", () => {
  it("returns a schema-valid 202 with Location for queued work", async () => {
    // Break caught: the bot could receive a non-pollable queued response.
    const response = await POST(jsonRequest({ characterUrl }));
    expect(response.status).toBe(202);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("location")).toBe(`/api/v1/searches/${jobId}`);
    expect(createSearchResponseSchema.parse(await response.json()).kind).toBe(
      "job"
    );
  });

  it("does not echo malformed input or authorization", async () => {
    // Break caught: validation errors could reflect secrets from the request.
    const marker = "secret-marker-f521";
    const response = await POST(
      jsonRequest(
        { characterUrl: marker },
        { authorization: `Bearer ${marker}` }
      )
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(safeApiErrorSchema.parse(body).error.code).toBe(
      "invalid_character_url"
    );
    expect(JSON.stringify(body)).not.toContain(marker);
  });

  it.each([
    [{ kind: "not_found", code: "character_not_found" }, 404, null],
    [{ kind: "not_found", code: "suppressed_character" }, 404, null],
    [{ kind: "unauthorized", code: "unauthorized" }, 401, null],
    [
      {
        kind: "client_ip_unavailable",
        code: "trusted_client_ip_unavailable"
      },
      503,
      null
    ],
    [{ kind: "rate_limited", retryAfterSeconds: 19 }, 429, "19"]
  ] as const)(
    "maps safe application result %#",
    async (result, status, retryAfter) => {
      // Break caught: policy outcomes could lose their public status or retry signal.
      searchResult = result;
      const response = await POST(jsonRequest({ characterUrl }));
      expect(response.status).toBe(status);
      expect(response.headers.get("retry-after")).toBe(retryAfter);
      expect(safeApiErrorSchema.safeParse(await response.json()).success).toBe(
        true
      );
    }
  );
});

describe("GET API resources", () => {
  it.each(["queued", "running", "retrying", "complete", "failed"] as const)(
    "returns a schema-valid %s job state with no-store",
    async (status) => {
      // Break caught: one worker state could become impossible for bot polling to parse.
      runResult = { ...job, status };
      const response = await GET_JOB(
        new Request(`https://slashwho.example/api/v1/searches/${jobId}`),
        { params: Promise.resolve({ jobId }) }
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(jobStatusResponseSchema.parse(await response.json()).status).toBe(
        status
      );
    }
  );

  it("returns a cacheable current character and enforces the read bucket", async () => {
    // Break caught: public character reads could bypass their independent limiter.
    const request = new Request(
      "https://slashwho.example/api/v1/characters/eu/silvermoon/ryii",
      { headers: { "x-real-ip": "203.0.113.8" } }
    );
    let response = await GET_CHARACTER(request, characterContext);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=60");
    expect(
      characterResourceSchema.safeParse(await response.json()).success
    ).toBe(true);

    readAuthorization = { allowed: false, retryAfterSeconds: 8 };
    response = await GET_CHARACTER(request, characterContext);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("8");
  });

  it("paginates history and returns immutable historical membership", async () => {
    // Break caught: history adapters could drop cursors or fetch the current snapshot by mistake.
    const historyResponse = await GET_HISTORY(
      new Request(
        "https://slashwho.example/api/v1/characters/eu/silvermoon/ryii/history?cursor=opaque"
      ),
      characterContext
    );
    expect(historyPageSchema.parse(await historyResponse.json())).toEqual(
      history
    );

    const snapshotResponse = await GET_SNAPSHOT(
      new Request(
        `https://slashwho.example/api/v1/characters/eu/silvermoon/ryii/history/${snapshotId}`
      ),
      {
        params: Promise.resolve({
          ...(await characterContext.params),
          snapshotId
        })
      }
    );
    expect(
      historicalSnapshotSchema.parse(await snapshotResponse.json())
    ).toEqual(historical);
  });

  it("permanently redirects non-canonical route casing", async () => {
    // Break caught: equivalent keys could be indexed and cached under duplicate URLs.
    const response = await GET_CHARACTER(
      new Request(
        "https://slashwho.example/api/v1/characters/EU/Silvermoon/Ryii"
      ),
      {
        params: Promise.resolve({
          region: "EU",
          realm: "Silvermoon",
          name: "Ryii"
        })
      }
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "/api/v1/characters/eu/silvermoon/ryii"
    );
  });
});

it("keeps every bot-facing v1 fixture compatible with shared contracts", () => {
  // Break caught: a public schema change could silently break SeriouslyCasualBotV2.
  expect(
    createSearchResponseSchema.parse(botClientFixture.search.response).kind
  ).toBe("job");
  expect(
    jobStatusResponseSchema.parse(botClientFixture.job.response).status
  ).toBe("retrying");
  expect(
    characterResourceSchema.parse(botClientFixture.character.response).character
      .name
  ).toBe("Ryii");
  expect(
    historyPageSchema.parse(botClientFixture.history.response).items
  ).toHaveLength(1);
  expect(
    historicalSnapshotSchema.parse(botClientFixture.snapshot.response)
      .characters
  ).toHaveLength(1);
  expect(
    safeApiErrorSchema.safeParse(botClientFixture.error.response).success
  ).toBe(true);
});
expect(
  createSearchRequestSchema.parse(botClientFixture.search.request).characterUrl
).toBe(characterUrl);
