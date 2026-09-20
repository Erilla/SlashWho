import { safeApiErrorSchema } from "@slashwho/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const operatorKey = "operator-secret-that-is-at-least-32-characters";
const list = vi.fn();

vi.mock("../../../../server/container", () => ({
  getContainer: async () => ({ collectionMonitor: { list } })
}));

vi.mock("../../../../server/config", () => ({
  loadWebConfig: () => ({
    application: {
      BOT_API_KEY: operatorKey,
      RATE_LIMIT_HASH_SECRET: "rate-limit-secret-that-is-32-chars",
      ANONYMOUS_SEARCHES_PER_HOUR: 10,
      BOT_SEARCHES_PER_HOUR: 60,
      PUBLIC_READS_PER_MINUTE: 300,
      FRESHNESS_HOURS: 24,
      DOSSIER_CHARACTER_CAP: 12,
      DOSSIER_PROVIDER_CONCURRENCY: 4,
      NEGATIVE_CACHE_TTL_MS: 300_000
    }
  })
}));

import { GET } from "./route";

const monitor = {
  generatedAt: "2026-09-20T12:00:00.000Z",
  inFlight: [
    {
      character: { region: "eu", realm: "silvermoon", name: "ryii" },
      status: "running",
      attempt: 1,
      startedAt: "2026-09-20T11:45:00.000Z",
      elapsedSeconds: 900,
      retryAfterAt: null
    }
  ],
  completed: [],
  failed: []
};

function request(authorization?: string): Request {
  return new Request(
    "https://slashwho.example/api/operations/collection-monitor",
    {
      headers: {
        ...(authorization ? { authorization } : {}),
        "x-real-ip": "203.0.113.8"
      }
    }
  );
}

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue(monitor);
});

describe("GET /api/operations/collection-monitor", () => {
  it.each([
    ["a public request", undefined],
    ["an invalid Bearer credential", `Bearer ${"x".repeat(40)}`]
  ])("rejects %s before reading character run identities", async (_, token) => {
    const response = await GET(request(token));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(safeApiErrorSchema.parse(await response.json()).error.code).toBe(
      "unauthorized"
    );
    expect(list).not.toHaveBeenCalled();
  });

  it("returns the collection monitor to an authenticated operator", async () => {
    const response = await GET(request(`Bearer ${operatorKey}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(monitor);
    expect(list).toHaveBeenCalledOnce();
  });

  it("fails closed if an internal field reaches the response boundary", async () => {
    const marker = "encrypted-visitor-credential";
    list.mockResolvedValue({
      ...monitor,
      inFlight: [{ ...monitor.inFlight[0], wclClientSecretEncrypted: marker }]
    });

    const response = await GET(request(`Bearer ${operatorKey}`));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(marker);
    expect(safeApiErrorSchema.parse(JSON.parse(body)).error.code).toBe(
      "search_failed"
    );
  });
});
