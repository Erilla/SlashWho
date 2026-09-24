// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({
  default: ({ children, href }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href}>{children}</a>
  )
}));
import { OperatorLoginForm } from "./operator-login-form";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.replace.mockReset();
  router.refresh.mockReset();
});

it("submits email and password, clears the password, and navigates", async () => {
  const changed = vi.fn();
  window.addEventListener("slashwho:account-session-changed", changed, {
    once: true
  });
  const password = "abcdef";
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<OperatorLoginForm />);
  await user.type(screen.getByLabelText("Email address"), "ryan@example.test");
  const input = screen.getByLabelText("Password");
  expect(input).toHaveAttribute("minlength", "6");
  await user.type(input, password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(fetchMock).toHaveBeenCalledWith("/api/operations/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "ryan@example.test", password })
  });
  expect(input).toHaveValue("");
  expect(router.replace).toHaveBeenCalledWith("/account");
  expect(changed).toHaveBeenCalledOnce();
});

it("directs a required password change to its own form", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(null, {
        status: 204,
        headers: { "x-password-change-required": "1" }
      })
    )
  );
  const user = userEvent.setup();
  render(<OperatorLoginForm />);
  await user.type(screen.getByLabelText("Email address"), "ryan@example.test");
  await user.type(
    screen.getByLabelText("Password"),
    "password-at-least-20-characters"
  );
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(router.replace).toHaveBeenCalledWith("/account/change-password");
});
