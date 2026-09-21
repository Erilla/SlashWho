import { beforeEach, expect, it, vi } from "vitest";
import {
  operatorAuthFixture,
  operatorMutation
} from "../../../../../server/operator-auth-test-fixture";
let fixture: Awaited<ReturnType<typeof operatorAuthFixture>>;
vi.mock("../../../../../server/container", () => ({
  getContainer: async () => ({ operatorAuth: fixture.auth })
}));
import { POST } from "./route";
beforeEach(async () => {
  fixture = await operatorAuthFixture();
});

it("revokes only the presented session and expires its browser cookie", async () => {
  const cookie = await fixture.cookie();
  const other = await fixture.cookie();
  const response = await POST(operatorMutation({}, { cookie }));
  expect(response.status).toBe(204);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(response.headers.get("set-cookie")).toContain(
    "HttpOnly; Secure; SameSite=Strict"
  );
  expect(await response.text()).toBe("");
  expect(
    (
      await fixture.auth.authenticateOperator(
        new Request("https://slashwho.example", { headers: { cookie } })
      )
    ).principal
  ).toBeNull();
  expect(
    (
      await fixture.auth.authenticateOperator(
        new Request("https://slashwho.example", { headers: { cookie: other } })
      )
    ).principal?.kind
  ).toBe("operator");
});

it.each([
  [{ origin: "https://evil.example" }, "POST"],
  [{ "sec-fetch-site": "cross-site" }, "POST"],
  [{ "content-type": "text/plain" }, "POST"],
  [{}, "DELETE"]
] as const)(
  "rejects unsafe sign-out without expiry or revocation (%j)",
  async (headers, method) => {
    const cookie = await fixture.cookie();
    const response = await POST(
      operatorMutation({}, { cookie, ...headers }, method)
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fixture.repository.revokeSession).not.toHaveBeenCalled();
  }
);

it("accepts sign-out without an active session and clears the stale cookie", async () => {
  const response = await POST(
    operatorMutation({}, { cookie: "__Host-slashwho-operator=legacy" })
  );
  expect(response.status).toBe(204);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
});
