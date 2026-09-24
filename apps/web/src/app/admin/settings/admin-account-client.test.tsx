// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminAccountClient } from "./admin-account-client";

const account = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "admin@example.test",
  role: "admin" as const,
  active: true,
  verifiedAt: "2026-09-23T00:00:00.000Z",
  createdAt: "2026-09-23T00:00:00.000Z"
};
const fetchMock = vi.fn();
const confirmMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  confirmMock.mockReset().mockReturnValue(true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    callback(0)
  );
  vi.stubGlobal("confirm", confirmMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("requires confirmation before changing a role", async () => {
  confirmMock.mockReturnValue(false);
  render(<AdminAccountClient initialAccounts={[account]} />);
  fireEvent.click(screen.getByRole("button", { name: "Make user" }));
  expect(confirmMock).toHaveBeenCalledWith(
    expect.stringContaining("change admin@example.test's role to user")
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it("announces last-admin conflict and focuses the result", async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 409 }));
  render(<AdminAccountClient initialAccounts={[account]} />);
  fireEvent.click(screen.getByRole("button", { name: "Disable" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("last active admin")
  );
  expect(screen.getByRole("status")).toHaveFocus();
  expect(screen.getByRole("button", { name: "Disable" })).toBeEnabled();
});

it("reports committed mutation and removes controls after session revocation", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }));
  render(<AdminAccountClient initialAccounts={[account]} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Require password change" })
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "admin@example.test updated"
    )
  );
  expect(screen.getByRole("status")).toHaveTextContent("Sign in again");
  expect(
    screen.queryByRole("button", { name: "Require password change" })
  ).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/operations/login"
  );
  expect(screen.getByRole("status")).toHaveFocus();
});

it("reports committed mutation when list refresh fails", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 500 }));
  render(<AdminAccountClient initialAccounts={[account]} />);
  fireEvent.click(screen.getByRole("button", { name: "Make user" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "admin@example.test updated"
    )
  );
  expect(screen.getByRole("status")).toHaveTextContent("Could not refresh");
  expect(
    screen.queryByRole("button", { name: "Make user" })
  ).not.toBeInTheDocument();
});

it.each(["Make user", "Disable"])(
  "explains loss of admin rights after %s",
  async (button) => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    render(<AdminAccountClient initialAccounts={[account]} />);
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Admin access ended")
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Another admin may restore your access"
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "Sign in again to continue"
    );
  }
);
