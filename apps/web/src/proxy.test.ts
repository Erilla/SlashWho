import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  automationKey,
  accountAuthFixture,
  operatorOrigin
} from "./server/operator-auth-test-fixture";

let fixture: Awaited<ReturnType<typeof accountAuthFixture>>;
vi.mock("./server/container", () => ({
  getContainer: async () => ({ accountAuth: fixture.auth })
}));
vi.mock("./server/config", () => ({
  loadWebConfig: () => ({ operatorAuth: { origin: operatorOrigin } })
}));

import { config, proxy } from "./proxy";

function navigation(headers: Record<string, string> = {}, method = "GET") {
  return new NextRequest(`${operatorOrigin}/operations/collection-monitor`, {
    method,
    headers
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z"));
  fixture = await accountAuthFixture();
  fixture.setAccount({ role: "admin" });
  fixture.setTime(new Date("2026-09-21T12:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

it("renews the browser cookie during page-only navigation beyond its initial idle expiry", async () => {
  const cookie = await fixture.cookie();
  vi.setSystemTime(new Date("2026-09-21T12:20:00.000Z"));
  fixture.setTime(new Date("2026-09-21T12:20:00.000Z"));
  const first = await proxy(navigation({ cookie }));
  expect(first.headers.get("x-middleware-next")).toBe("1");
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(first.headers.get("set-cookie")).toContain(cookie);
  expect(first.headers.get("set-cookie")).toContain(
    "Expires=Tue, 26 Oct 2027 12:20:00 GMT"
  );
  expect(first.headers.get("set-cookie")).toContain(
    "HttpOnly; Secure; SameSite=Strict"
  );

  // Past the 400-day deadline set at sign-in, inside the one renewed above.
  vi.setSystemTime(new Date("2027-10-26T12:10:00.000Z"));
  fixture.setTime(new Date("2027-10-26T12:10:00.000Z"));
  const second = await proxy(navigation({ cookie }));
  expect(second.headers.get("x-middleware-next")).toBe("1");
  expect(second.headers.get("set-cookie")).toContain(
    "Expires=Wed, 29 Nov 2028 12:10:00 GMT"
  );
});

it.each(["legacy.signed.cookie", "invalid"])(
  "expires stale page cookie %s before redirecting to sign-in",
  async (value) => {
    const response = await proxy(
      navigation({ cookie: `__Host-slashwho-operator=${value}` })
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `${operatorOrigin}/operations/login`
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).toContain(
      "HttpOnly; Secure; SameSite=Strict"
    );
    expect(response.headers.get("x-middleware-next")).toBeNull();
  }
);

it("denies an invalid Bearer credential without falling back to or mutating a valid browser session", async () => {
  const cookie = await fixture.cookie();
  vi.mocked(fixture.repository.useSession).mockClear();
  const response = await proxy(
    navigation({ cookie, authorization: "Bearer invalid" })
  );
  expect(response.status).toBe(307);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(fixture.repository.useSession).not.toHaveBeenCalled();
});

it("denies valid Bearer navigation without touching stale cookies", async () => {
  const response = await proxy(
    navigation({
      authorization: `Bearer ${automationKey}`,
      cookie: "__Host-slashwho-operator=legacy"
    })
  );
  expect(response.status).toBe(307);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(fixture.repository.useSession).not.toHaveBeenCalled();
});

it("does not apply cookies on a non-navigation method", async () => {
  const cookie = await fixture.cookie();
  vi.mocked(fixture.repository.useSession).mockClear();
  const response = await proxy(navigation({ cookie }, "POST"));
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(fixture.repository.useSession).not.toHaveBeenCalled();
});

it.each([
  ["/operations/collection-monitor", true],
  ["/operations/collection-monitor?_rsc=abc", true],
  ["/admin/settings", true],
  ["/operations/login", false],
  ["/api/operations/session", false],
  ["/api/operations/session/logout", false],
  ["/api/operations/collection-monitor", false],
  ["/", false]
])("intercepts only protected page navigation: %s", (url, expected) => {
  expect(
    unstable_doesMiddlewareMatch({ config, url: `${operatorOrigin}${url}` })
  ).toBe(expected);
});
