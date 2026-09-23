import { beforeEach, expect, it, vi } from "vitest";
import {
  accountAuthFixture,
  operatorMutation
} from "../../../../../server/operator-auth-test-fixture";
let fixture: Awaited<ReturnType<typeof accountAuthFixture>>;
vi.mock("../../../../../server/container", () => ({
  getContainer: async () => ({ accountAuth: fixture.auth })
}));
import { POST } from "./route";
beforeEach(async () => {
  fixture = await accountAuthFixture();
});

it("revokes the presented account session", async () => {
  const cookie = await fixture.cookie();
  const response = await POST(operatorMutation({}, { cookie }));
  expect(response.status).toBe(204);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(
    (
      await fixture.auth.authenticate(
        new Request("https://slashwho.example", { headers: { cookie } })
      )
    ).principal
  ).toBeNull();
});

it("denies cross-site sign-out", async () => {
  const cookie = await fixture.cookie();
  const response = await POST(
    operatorMutation({}, { cookie, origin: "https://evil.example" })
  );
  expect(response.status).toBe(401);
  expect(
    (
      await fixture.auth.authenticate(
        new Request("https://slashwho.example", { headers: { cookie } })
      )
    ).principal?.kind
  ).toBe("account");
});

const unsafeHeaders: Record<string, string>[] = [
  { origin: "https://evil.example" },
  { "sec-fetch-site": "cross-site" },
  { "content-type": "text/plain" },
  { authorization: "Bearer bad" }
];
it.each(unsafeHeaders)(
  "preserves a live cookie after unsafe sign-out",
  async (headers) => {
    const cookie = await fixture.cookie();
    const response = await POST(operatorMutation({}, { cookie, ...headers }));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(
      (
        await fixture.auth.authenticate(
          new Request("https://slashwho.example", { headers: { cookie } })
        )
      ).principal?.kind
    ).toBe("account");
  }
);

it("clears a malformed stale cookie on safe sign-out", async () => {
  const response = await POST(
    operatorMutation({}, { cookie: "__Host-slashwho-operator=legacy" })
  );
  expect(response.status).toBe(204);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
});
