import { beforeEach, expect, it, vi } from "vitest";
import {
  accountAuthFixture,
  automationKey,
  operatorOrigin
} from "../../../../../server/operator-auth-test-fixture";

let fixture: Awaited<ReturnType<typeof accountAuthFixture>>;
const accountAdmin = {
  setRole: vi.fn(),
  setActive: vi.fn(),
  requirePasswordChange: vi.fn()
};
vi.mock("../../../../../server/container", () => ({
  getContainer: async () => ({
    accountAuth: fixture.auth,
    accountAdmin,
    accountOrigin: operatorOrigin
  })
}));
import { POST } from "./route";

const target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const context = { params: Promise.resolve({ accountId: target }) };
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${operatorOrigin}/api/admin/accounts/${target}`, {
    method: "POST",
    headers: {
      origin: operatorOrigin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}
beforeEach(async () => {
  fixture = await accountAuthFixture();
  accountAdmin.setRole.mockReset().mockResolvedValue("updated");
  accountAdmin.setActive.mockReset().mockResolvedValue("updated");
  accountAdmin.requirePasswordChange.mockReset().mockResolvedValue(true);
});

it("denies users and bearer callers before mutation", async () => {
  expect(
    (
      await POST(
        request(
          { action: "role", role: "admin" },
          { cookie: await fixture.cookie() }
        ),
        context
      )
    ).status
  ).toBe(403);
  expect(
    (
      await POST(
        request(
          { action: "role", role: "admin" },
          { authorization: `Bearer ${automationKey}` }
        ),
        context
      )
    ).status
  ).toBe(403);
  expect(accountAdmin.setRole).not.toHaveBeenCalled();
});

it("protects the last admin and validates mutation metadata", async () => {
  fixture.setAccount({ role: "admin" });
  const cookie = await fixture.cookie();
  accountAdmin.setRole.mockResolvedValue("last_admin");
  expect(
    (await POST(request({ action: "role", role: "user" }, { cookie }), context))
      .status
  ).toBe(409);
  expect(
    (
      await POST(
        request(
          { action: "active", active: false },
          { cookie, origin: "https://evil.test" }
        ),
        context
      )
    ).status
  ).toBe(400);
  expect(accountAdmin.setActive).not.toHaveBeenCalled();
});

it("allows admin status and reset actions", async () => {
  fixture.setAccount({ role: "admin" });
  const cookie = await fixture.cookie();
  expect(
    (
      await POST(
        request({ action: "active", active: false }, { cookie }),
        context
      )
    ).status
  ).toBe(200);
  expect(
    (
      await POST(
        request({ action: "require_password_change" }, { cookie }),
        context
      )
    ).status
  ).toBe(200);
  expect(accountAdmin.setActive).toHaveBeenCalledWith(
    expect.objectContaining({ targetId: target, active: false })
  );
  expect(accountAdmin.requirePasswordChange).toHaveBeenCalledOnce();
});
