import { safeApiErrorSchema } from "@slashwho/contracts";
import { describe, expect, it, vi } from "vitest";

const operatorKey = "operator-secret-that-is-at-least-32-characters";

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

import { DELETE, POST } from "./route";

function loginRequest(
  body: unknown,
  options: { contentType?: string; url?: string } = {}
): Request {
  return new Request(
    options.url ?? "https://slashwho.example/api/operations/session",
    {
      method: "POST",
      headers: {
        "content-type": options.contentType ?? "application/json"
      },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }
  );
}

describe("POST /api/operations/session", () => {
  it("sets a hardened opaque session cookie for the configured operator key", async () => {
    const response = await POST(loginRequest({ operatorKey }));
    const cookie = response.headers.get("set-cookie");

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cookie).toMatch(
      /^__Host-slashwho-operator=[A-Za-z0-9._-]+; Path=\/; Max-Age=1800; HttpOnly; Secure; SameSite=Strict$/
    );
    expect(cookie).not.toContain(operatorKey);
    expect(await response.text()).toBe("");
  });

  it.each([
    ["a wrong key", { operatorKey: "x".repeat(40) }, "application/json"],
    ["a missing key", {}, "application/json"],
    ["malformed JSON", "{", "application/json"],
    [
      "a form submission",
      `operatorKey=${operatorKey}`,
      "application/x-www-form-urlencoded"
    ]
  ])(
    "rejects %s without setting or reflecting a credential",
    async (_, body, contentType) => {
      const response = await POST(loginRequest(body, { contentType }));
      const text = await response.text();

      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(text).not.toContain(operatorKey);
      expect(safeApiErrorSchema.parse(JSON.parse(text)).error.code).toBe(
        "unauthorized"
      );
    }
  );

  it("never accepts or reflects a key supplied in the URL", async () => {
    const response = await POST(
      loginRequest(
        {},
        {
          url: `https://slashwho.example/api/operations/session?operatorKey=${operatorKey}`
        }
      )
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).not.toContain(operatorKey);
  });
});

describe("DELETE /api/operations/session", () => {
  it("expires the operator cookie with its security attributes intact", async () => {
    const response = await DELETE();

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBe(
      "__Host-slashwho-operator=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"
    );
  });
});
