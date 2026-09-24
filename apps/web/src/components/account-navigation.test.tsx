// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({
  default: ({ children, href }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href}>{children}</a>
  )
}));
import { AccountNavigation } from "./account-navigation";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("refreshes the projection after sign-in and password change", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ account: null }))
    .mockResolvedValueOnce(
      Response.json({
        account: {
          email: "admin@example.test",
          role: "admin",
          passwordChangeRequired: false
        }
      })
    )
    .mockResolvedValueOnce(Response.json({ account: null }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AccountNavigation />);
  expect(await screen.findByRole("link", { name: "Sign in" })).toBeVisible();
  window.dispatchEvent(new Event("slashwho:account-session-changed"));
  expect(
    await screen.findByRole("link", { name: "Admin settings" })
  ).toBeVisible();
  window.dispatchEvent(new Event("slashwho:account-session-changed"));
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "Admin settings" })).toBeNull()
  );
  expect(screen.getByRole("link", { name: "Sign in" })).toBeVisible();
});

it("shows retry feedback and keeps account controls when sign-out fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          account: {
            email: "user@example.test",
            role: "user",
            passwordChangeRequired: false
          }
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
  );
  const user = userEvent.setup();
  render(<AccountNavigation />);
  await user.click(await screen.findByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("try again");
  expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
});
