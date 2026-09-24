// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
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
  await user.type(password, "password-at-least-20-characters{Enter}");
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
