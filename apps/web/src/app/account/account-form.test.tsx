// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
const query = vi.hoisted(() => ({ token: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () =>
    new URLSearchParams(query.token ? { token: query.token } : {})
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href}>{children}</a>
  )
}));
import { AccountForm } from "./account-form";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.refresh.mockClear();
  router.replace.mockClear();
  query.token = "";
});

it("takes the newly verified account directly to its page", async () => {
  query.token = "verification-token";
  const changed = vi.fn();
  window.addEventListener("slashwho:account-session-changed", changed, {
    once: true
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ message: "Email verified. You are signed in." })
      )
  );
  const user = userEvent.setup();
  render(<AccountForm flow="verify" />);
  await user.type(screen.getByLabelText("Password"), "abcdef");
  await user.click(screen.getByRole("button", { name: "Verify email" }));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/account"));
  expect(changed).toHaveBeenCalledOnce();
});

it("submits registration by keyboard, clears its password, and focuses feedback", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ message: "Check your email." }, { status: 202 })
      )
  );
  const user = userEvent.setup();
  render(<AccountForm flow="create" />);
  await user.type(screen.getByLabelText("Email address"), "ryan@example.test");
  const password = screen.getByLabelText("Password");
  expect(password).toHaveAttribute("minlength", "6");
  await user.type(password, "abcdef{Enter}");
  expect(password).toHaveValue("");
  await waitFor(() => expect(screen.getByRole("status")).toHaveFocus());
  expect(screen.getByRole("status")).toHaveTextContent("Check your email.");
});

it("shows and submits the resend form when verification has no token", async () => {
  const send = vi
    .fn()
    .mockResolvedValue(
      Response.json({ message: "Check your email." }, { status: 202 })
    );
  vi.stubGlobal("fetch", send);
  const user = userEvent.setup();
  render(<AccountForm flow="verify" />);
  await user.type(screen.getByLabelText("Email address"), "ryan@example.test");
  await user.click(
    screen.getByRole("button", { name: "Send verification link" })
  );
  expect(send).toHaveBeenCalledWith(
    "/api/account/verification-resend",
    expect.objectContaining({ method: "POST" })
  );
  await waitFor(() => expect(screen.getByRole("status")).toHaveFocus());
});

it("refreshes the persistent header after a signed-in password change", async () => {
  const changed = vi.fn();
  window.addEventListener("slashwho:account-session-changed", changed, {
    once: true
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ message: "Password changed." }))
  );
  const user = userEvent.setup();
  render(<AccountForm flow="change-password" />);
  await user.type(
    screen.getByLabelText("Current password"),
    "current-password-at-least-20"
  );
  await user.type(
    screen.getByLabelText("New password"),
    "new-password-at-least-20"
  );
  await user.click(screen.getByRole("button", { name: "Change password" }));
  expect(changed).toHaveBeenCalledOnce();
});
