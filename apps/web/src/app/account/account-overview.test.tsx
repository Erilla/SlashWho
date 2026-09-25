// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    className
  }: React.PropsWithChildren<{ href: string; className?: string }>) => (
    <a href={href} className={className}>
      {children}
    </a>
  )
}));
import { AccountOverview } from "./account-overview";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function signedIn(passwordChangeRequired = false) {
  return Response.json({
    account: {
      email: "raider@example.test",
      role: "user",
      passwordChangeRequired
    }
  });
}

it("shows the signed-in email above labelled account actions", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(signedIn()));
  render(<AccountOverview />);
  expect(screen.getByRole("heading", { name: "Account" })).toBeVisible();
  expect(await screen.findByText("raider@example.test")).toBeVisible();
  expect(screen.getByText("raider@example.test").closest("a")).toBeNull();
  const actions = within(
    screen.getByRole("navigation", { name: "Account settings" })
  );
  expect(actions.getByRole("link", { name: /Key settings/ })).toHaveAttribute(
    "href",
    "/settings"
  );
  expect(
    actions.getByRole("link", { name: /Change password/ })
  ).toHaveAttribute("href", "/account/change-password");
  expect(actions.getByRole("link", { name: /Change email/ })).toHaveAttribute(
    "href",
    "/account/email"
  );
  expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
});

it("asks for a new password before anything else when one is required", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(signedIn(true)));
  render(<AccountOverview />);
  expect(
    await screen.findByText(
      "Change your password to continue using your account."
    )
  ).toBeVisible();
  const links = within(
    screen.getByRole("navigation", { name: "Account settings" })
  ).getAllByRole("link");
  expect(links[0]).toHaveAccessibleName(/Change password/);
});

it("offers sign-in instead of account actions when signed out", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ account: null }))
  );
  render(<AccountOverview />);
  expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/operations/login"
  );
  expect(screen.getByRole("link", { name: "Create account" })).toBeVisible();
  expect(
    screen.queryByRole("navigation", { name: "Account settings" })
  ).toBeNull();
});

it("reports that it is checking the session before the answer arrives", () => {
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
  render(<AccountOverview />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Checking your session…"
  );
  expect(
    screen.queryByRole("navigation", { name: "Account settings" })
  ).toBeNull();
});

it("follows the header when the session changes", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(signedIn())
      .mockResolvedValueOnce(Response.json({ account: null }))
  );
  render(<AccountOverview />);
  expect(await screen.findByText("raider@example.test")).toBeVisible();
  window.dispatchEvent(new Event("slashwho:account-session-changed"));
  expect(await screen.findByRole("link", { name: "Sign in" })).toBeVisible();
  expect(screen.queryByText("raider@example.test")).toBeNull();
});
