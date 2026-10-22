import { beforeEach, describe, expect, it, vi } from "vitest";

const status = vi.fn();
const authorizePublicRead = vi.fn(async () => ({ allowed: true as const }));

vi.mock("../../../../../../../../server/container", () => ({
  getContainer: async () => ({
    botDossiers: { status },
    searches: { authorizePublicRead }
  })
}));

vi.mock("../../../../../../../../server/config", () => ({
  loadWebConfig: () => ({
    application: {
      BOT_API_KEY: "b".repeat(32),
      RATE_LIMIT_HASH_SECRET: "r".repeat(32)
    }
  })
}));

import { GET } from "./route";

const key = { region: "eu", realm: "silvermoon", name: "ryii" };
const context = {
  params: Promise.resolve(key)
};
const authorisation = `Bearer ${"b".repeat(32)}`;

function request(headers: Record<string, string> = {}): Request {
  return new Request(
    "https://slashwho.example/api/v1/dossiers/eu/silvermoon/ryii/status",
    { headers }
  );
}

describe("GET /api/v1/dossiers/{key}/status", () => {
  beforeEach(() => {
    status.mockReset();
    authorizePublicRead.mockClear();
  });

  it("refuses an anonymous caller", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(401);
    expect(status).not.toHaveBeenCalled();
  });

  it("returns a small body and 304s on a matching tag", async () => {
    status.mockResolvedValue({
      kind: "ok",
      snapshotId: "13af3173-e97c-4c78-a6cb-a54b647b209f",
      snapshotState: "complete",
      snapshotLimitationCode: null,
      lastCollectedAt: new Date("2026-10-22T09:45:52.977Z"),
      evidence: [
        {
          key,
          evidenceState: "complete",
          completedAt: new Date("2026-10-22T09:45:52.977Z"),
          limitations: []
        }
      ],
      limitations: [],
      evidenceRunIds: [],
      activeDiscovery: false
    });
    const first = await GET(request({ authorization: authorisation }), context);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { etag: string };
    expect(first.headers.get("cache-control")).toBe("no-store");

    const second = await GET(
      request({
        authorization: authorisation,
        "if-none-match": body.etag
      }),
      context
    );
    expect(second.status).toBe(304);
    expect(second.headers.get("cache-control")).toBe("no-store");
  });

  it("404s an unknown key", async () => {
    status.mockResolvedValue({ kind: "not_found" });
    const response = await GET(
      request({ authorization: authorisation }),
      context
    );
    expect(response.status).toBe(404);
  });
});
