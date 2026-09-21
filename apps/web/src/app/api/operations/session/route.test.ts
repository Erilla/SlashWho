import { safeApiErrorSchema } from "@slashwho/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  operatorAuthFixture,
  operatorCredential,
  operatorLogin,
  operatorMutation
} from "../../../../server/operator-auth-test-fixture";

let fixture: Awaited<ReturnType<typeof operatorAuthFixture>>;
const list = vi.fn();
vi.mock("../../../../server/container", () => ({
  getContainer: async () => ({
    operatorAuth: fixture.auth,
    collectionMonitor: { list }
  })
}));
import { POST } from "./route";

beforeEach(async () => {
  fixture = await operatorAuthFixture();
  list.mockReset();
});

describe("POST /api/operations/session", () => {
  it("issues an opaque hardened cookie without reflecting identity or credential", async () => {
    const response = await POST(
      operatorMutation({ login: operatorLogin, credential: operatorCredential })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toMatch(
      /^__Host-slashwho-operator=v1\.[a-f0-9-]+\.[A-Za-z0-9_-]+;/
    );
    for (const attribute of [
      "Path=/",
      "Max-Age=1800",
      "HttpOnly",
      "Secure",
      "SameSite=Strict"
    ])
      expect(cookie).toContain(attribute);
    expect(cookie).not.toContain(operatorLogin);
    expect(cookie).not.toContain(operatorCredential);
    expect(await response.text()).toBe("");
  });

  it.each([
    [
      "wrong credential",
      { login: operatorLogin, credential: "x".repeat(40) },
      {},
      "POST"
    ],
    [
      "unknown login",
      { login: "unknown", credential: operatorCredential },
      {},
      "POST"
    ],
    ["legacy key", { operatorKey: operatorCredential }, {}, "POST"],
    ["malformed JSON", "{", {}, "POST"],
    [
      "non JSON",
      { login: operatorLogin, credential: operatorCredential },
      { "content-type": "text/plain" },
      "POST"
    ],
    [
      "cross origin",
      { login: operatorLogin, credential: operatorCredential },
      { origin: "https://evil.example" },
      "POST"
    ],
    [
      "missing origin",
      { login: operatorLogin, credential: operatorCredential },
      { origin: "" },
      "POST"
    ],
    [
      "cross-site metadata",
      { login: operatorLogin, credential: operatorCredential },
      { "sec-fetch-site": "cross-site" },
      "POST"
    ],
    [
      "missing metadata",
      { login: operatorLogin, credential: operatorCredential },
      { "sec-fetch-site": "" },
      "POST"
    ],
    ["invalid method", {}, {}, "GET"]
  ] as const)(
    "rejects %s generically without cookies or monitor reads",
    async (_, body, headers, method) => {
      const response = await POST(operatorMutation(body, headers, method));
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      expect(text).not.toContain(operatorCredential);
      expect(text).not.toContain(operatorLogin);
      expect(safeApiErrorSchema.parse(JSON.parse(text)).error.code).toBe(
        "unauthorized"
      );
      expect(list).not.toHaveBeenCalled();
    }
  );

  it("denies throttled login without issuing a cookie or checking credentials", async () => {
    vi.mocked(fixture.repository.admitLoginAttempt).mockResolvedValue({
      kind: "throttled",
      retryAt: new Date()
    });
    const response = await POST(
      operatorMutation({ login: operatorLogin, credential: operatorCredential })
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fixture.repository.findCredential).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("never applies a cookie directive returned with a rejected sign-in", async () => {
    const rejected = await fixture.auth.authenticateOperator(
      new Request("https://slashwho.example", {
        headers: { cookie: "__Host-slashwho-operator=legacy" }
      })
    );
    vi.spyOn(fixture.auth, "signIn").mockResolvedValue(rejected);
    const response = await POST(operatorMutation({}));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("does not accept or reflect credentials supplied only in the URL", async () => {
    const template = operatorMutation({});
    const response = await POST(
      new Request(
        `${template.url}?login=${operatorLogin}&credential=${operatorCredential}`,
        { method: "POST", headers: template.headers, body: "{}" }
      )
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).not.toContain(operatorCredential);
  });

  it("rejects a valid automation bearer key before browser sign-in", async () => {
    const response = await POST(
      operatorMutation(
        { login: operatorLogin, credential: operatorCredential },
        { authorization: `Bearer ${fixture.config.BOT_API_KEY}` }
      )
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fixture.repository.issueSession).not.toHaveBeenCalled();
  });
});
