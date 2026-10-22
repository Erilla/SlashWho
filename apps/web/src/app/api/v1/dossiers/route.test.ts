import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();

vi.mock("../../../../server/container", () => ({
  getContainer: async () => ({ botDossiers: { create } })
}));

vi.mock("../../../../server/config", () => ({
  loadWebConfig: () => ({
    application: {
      BOT_API_KEY: "b".repeat(32),
      RATE_LIMIT_HASH_SECRET: "r".repeat(32)
    }
  })
}));

import { POST } from "./route";

const url = "https://slashwho.example/api/v1/dossiers";
const key = { region: "eu", realm: "silvermoon", name: "ryii" };

function request(options: { body?: unknown; authorization?: string }): Request {
  const headers = new Headers();
  if (options.authorization !== undefined) {
    headers.set("authorization", options.authorization);
  }
  return new Request(url, {
    method: "POST",
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) })
  });
}

const authorisation = `Bearer ${"b".repeat(32)}`;

describe("POST /api/v1/dossiers", () => {
  beforeEach(() => {
    create.mockReset();
  });

  it("refuses an anonymous caller with 401, never the anonymous fallback", async () => {
    const response = await POST(
      request({ body: { characters: ["https://raider.io/x"] } })
    );
    expect(response.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an invalid URL without creating anything", async () => {
    const response = await POST(
      request({
        authorization: authorisation,
        body: { characters: ["not a url"] }
      })
    );
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("carries the root outcome and Retry-After on a root 429", async () => {
    create.mockResolvedValueOnce({
      kind: "rate_limited",
      retryAfterSeconds: 17,
      root: key,
      outcomes: [{ key, outcome: "rate_limited" }]
    });
    const response = await POST(
      request({
        authorization: authorisation,
        body: {
          characters: ["https://raider.io/characters/eu/silvermoon/ryii"]
        }
      })
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    await expect(response.json()).resolves.toMatchObject({
      root: key,
      state: "collecting",
      outcomes: [{ key, outcome: "rate_limited" }],
      retryAfterSeconds: 17
    });
  });

  it("returns the per-character create result", async () => {
    create.mockResolvedValueOnce({
      kind: "created",
      status: 202,
      body: {
        root: key,
        state: "collecting",
        snapshotId: null,
        lastCollectedAt: null,
        evidenceRunIds: [],
        outcomes: [
          {
            key,
            outcome: "queued",
            jobId: "00000000-0000-4000-8000-000000000010"
          }
        ]
      }
    });
    const response = await POST(
      request({
        authorization: authorisation,
        body: {
          characters: ["https://raider.io/characters/eu/silvermoon/ryii"]
        }
      })
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      root: key,
      outcomes: [{ outcome: "queued" }]
    });
  });
});
