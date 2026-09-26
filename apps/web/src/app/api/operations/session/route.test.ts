import { beforeEach, expect, it, vi } from "vitest";
import {
  accountAuthFixture,
  accountEmail,
  automationKey,
  operatorCredential,
  operatorMutation
} from "../../../../server/operator-auth-test-fixture";
let fixture: Awaited<ReturnType<typeof accountAuthFixture>>;
vi.mock("../../../../server/container", () => ({
  getContainer: async () => ({ accountAuth: fixture.auth })
}));
import { POST } from "./route";
beforeEach(async () => {
  fixture = await accountAuthFixture();
});

it("signs in a verified email and issues an opaque cookie", async () => {
  const response = await POST(
    operatorMutation({ email: accountEmail, password: operatorCredential })
  );
  expect(response.status).toBe(204);
  expect(response.headers.get("set-cookie")).toMatch(
    /^__Host-slashwho-operator=v1\./
  );
  for (const attribute of [
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Max-Age=34560000"
  ])
    expect(response.headers.get("set-cookie")).toContain(attribute);
  expect(response.headers.get("set-cookie")).not.toContain(accountEmail);
  expect(response.headers.get("set-cookie")).not.toContain(operatorCredential);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("");
});

it.each([
  [{ email: accountEmail, password: "wrong-password-at-least-20" }, {}],
  [
    { email: accountEmail, password: operatorCredential },
    { origin: "https://evil.example" }
  ],
  [
    { email: accountEmail, password: operatorCredential },
    { "sec-fetch-site": "cross-site" }
  ],
  [
    { email: accountEmail, password: operatorCredential },
    { authorization: "Bearer bad" }
  ],
  [
    { email: accountEmail, password: operatorCredential },
    { authorization: `Bearer ${automationKey}` }
  ],
  [{ email: "unknown@example.test", password: operatorCredential }, {}],
  ["{", {}],
  [{ email: accountEmail, password: operatorCredential }, { origin: "" }],
  [
    { email: accountEmail, password: operatorCredential },
    { "sec-fetch-site": "" }
  ],
  [
    { email: accountEmail, password: operatorCredential },
    { "content-type": "text/plain" }
  ],
  [{ login: "legacy", credential: operatorCredential }, {}]
])("denies invalid sign-in without a cookie", async (body, headers) => {
  const response = await POST(operatorMutation(body, headers));
  expect(response.status).toBe(401);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(text).not.toContain(accountEmail);
  expect(text).not.toContain(operatorCredential);
});

it("denies throttled sign-in before loading the account", async () => {
  fixture.repository.admitLoginAttempt.mockResolvedValue({
    kind: "throttled",
    retryAt: new Date()
  } as never);
  const response = await POST(
    operatorMutation({ email: accountEmail, password: operatorCredential })
  );
  expect(response.status).toBe(401);
  expect(fixture.repository.findCredential).not.toHaveBeenCalled();
});

it("rejects an unverified account without issuing a cookie", async () => {
  fixture.setAccount({ verifiedAt: null });
  const response = await POST(
    operatorMutation({ email: accountEmail, password: operatorCredential })
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("set-cookie")).toBeNull();
});

it("does not apply a cookie directive from a rejected sign-in", async () => {
  const signIn = vi.spyOn(fixture.auth, "signIn").mockResolvedValue({
    principal: null,
    cookie: { header: "__Host-slashwho-operator=invalid" } as never
  });
  const response = await POST(
    operatorMutation({ email: accountEmail, password: operatorCredential })
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("set-cookie")).toBeNull();
  signIn.mockRestore();
});
