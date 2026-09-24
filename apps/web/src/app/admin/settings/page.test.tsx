// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  accountAuthFixture,
  automationKey
} from "../../../server/operator-auth-test-fixture";

let fixture: Awaited<ReturnType<typeof accountAuthFixture>>;
const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  redirect: vi.fn(),
  listAccounts: vi.fn()
}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("../../../server/container", () => ({
  getContainer: async () => ({
    accountAuth: fixture.auth,
    accountAdmin: { listAccounts: mocks.listAccounts },
    accountOrigin: "https://slashwho.example"
  })
}));
vi.mock("./admin-account-client", () => ({
  AdminAccountClient: () => <div>Accounts</div>
}));
import AdminSettingsPage from "./page";

beforeEach(async () => {
  fixture = await accountAuthFixture();
  mocks.headers.mockReset();
  mocks.redirect.mockReset();
  mocks.listAccounts.mockReset().mockResolvedValue([]);
  mocks.redirect.mockImplementation(() => {
    throw new Error("redirected");
  });
});
afterEach(cleanup);

it("denies a user and automation before account reads", async () => {
  for (const headers of [
    new Headers({ cookie: await fixture.cookie() }),
    new Headers({ authorization: `Bearer ${automationKey}` })
  ]) {
    mocks.headers.mockResolvedValue(headers);
    await expect(AdminSettingsPage()).rejects.toThrow("redirected");
  }
  expect(mocks.listAccounts).not.toHaveBeenCalled();
});

it("lists accounts for an admin", async () => {
  fixture.setAccount({ role: "admin" });
  mocks.headers.mockResolvedValue(
    new Headers({ cookie: await fixture.cookie() })
  );
  render(await AdminSettingsPage());
  expect(screen.getByText("Accounts")).toBeInTheDocument();
  expect(mocks.listAccounts).toHaveBeenCalledOnce();
});
