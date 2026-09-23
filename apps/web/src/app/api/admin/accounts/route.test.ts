import { beforeEach, expect, it, vi } from "vitest";
import {
  accountAuthFixture,
  automationKey
} from "../../../../server/operator-auth-test-fixture";

let fixture: Awaited<ReturnType<typeof accountAuthFixture>>;
const listAccounts = vi.fn();
vi.mock("../../../../server/container", () => ({
  getContainer: async () => ({
    accountAuth: fixture.auth,
    accountAdmin: { listAccounts }
  })
}));
import { GET } from "./route";

beforeEach(async () => {
  fixture = await accountAuthFixture();
  listAccounts.mockReset().mockResolvedValue([]);
});

it("denies users and automation before reading accounts", async () => {
  const cookie = await fixture.cookie();
  expect(
    (
      await GET(
        new Request("https://slashwho.example/api/admin/accounts", {
          headers: { cookie }
        })
      )
    ).status
  ).toBe(403);
  expect(
    (
      await GET(
        new Request("https://slashwho.example/api/admin/accounts", {
          headers: { authorization: `Bearer ${automationKey}` }
        })
      )
    ).status
  ).toBe(403);
  expect(listAccounts).not.toHaveBeenCalled();
});

it("lists safe summaries for a live admin", async () => {
  fixture.setAccount({ role: "admin" });
  const cookie = await fixture.cookie();
  const response = await GET(
    new Request("https://slashwho.example/api/admin/accounts", {
      headers: { cookie }
    })
  );
  expect(response.status).toBe(200);
  expect(listAccounts).toHaveBeenCalledWith(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  );
});
