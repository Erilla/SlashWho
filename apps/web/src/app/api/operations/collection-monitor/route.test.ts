import { safeApiErrorSchema } from "@slashwho/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  automationKey,
  operatorAuthFixture
} from "../../../../server/operator-auth-test-fixture";
let fixture: Awaited<ReturnType<typeof operatorAuthFixture>>;

const operatorKey = automationKey;
const list = vi.fn();

vi.mock("../../../../server/container", () => ({
  getContainer: async () => ({
    collectionMonitor: { list },
    operatorAuth: fixture.auth
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

function request(headers: Record<string, string> = {}): Request {
  return new Request(
    "https://slashwho.example/api/operations/collection-monitor",
    {
      headers: {
        ...headers,
        "x-real-ip": "203.0.113.8"
      }
    }
  );
}

beforeEach(async () => {
  fixture = await operatorAuthFixture();
  list.mockReset();
  list.mockResolvedValue(monitor);
});

describe("GET /api/operations/collection-monitor", () => {
  it.each([
    ["a public request", {}],
    [
      "an invalid Bearer credential",
      { authorization: `Bearer ${"x".repeat(40)}` }
    ],
    ["a tampered session", { cookie: "__Host-slashwho-operator=invalid" }]
  ])(
    "rejects %s before reading character run identities",
    async (_, headers) => {
      const response = await GET(request(headers));

      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(safeApiErrorSchema.parse(await response.json()).error.code).toBe(
        "unauthorized"
      );
      expect(list).not.toHaveBeenCalled();
    }
  );

  it("returns the collection monitor to an authenticated operator", async () => {
    const response = await GET(
      request({ authorization: `Bearer ${operatorKey}` })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(monitor);
    expect(list).toHaveBeenCalledOnce();
  });

  it("accepts the short-lived browser session cookie", async () => {
    const cookie = await fixture.cookie();
    const response = await GET(request({ cookie }));
    expect(response.headers.get("set-cookie")).toContain(cookie);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=1800");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(monitor);
    expect(list).toHaveBeenCalledOnce();
  });

  it("fails closed if an internal field reaches the response boundary", async () => {
    const marker = "encrypted-visitor-credential";
    list.mockResolvedValue({
      ...monitor,
      inFlight: [{ ...monitor.inFlight[0], wclClientSecretEncrypted: marker }]
    });

    const response = await GET(
      request({ authorization: `Bearer ${operatorKey}` })
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(marker);
    expect(safeApiErrorSchema.parse(JSON.parse(body)).error.code).toBe(
      "search_failed"
    );
  });
  it("expires legacy cookies before reading monitor data", async () => {
    const response = await GET(
      request({ cookie: "__Host-slashwho-operator=legacy.signed.cookie" })
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(list).not.toHaveBeenCalled();
  });

  it("does not fall back to a valid browser cookie for malformed authorization", async () => {
    const response = await GET(
      request({
        cookie: await fixture.cookie(),
        authorization: "Bearer invalid"
      })
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
});
