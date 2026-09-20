// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { OperatorLoginForm } from "./operator-login-form";

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OperatorLoginForm", () => {
  it("exchanges the key in a JSON body and navigates to the monitor", async () => {
    const operatorKey = "operator-secret-that-is-at-least-32-characters";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<OperatorLoginForm />);
    const input = screen.getByLabelText("Operator key");
    expect(input).toHaveAttribute("autocomplete", "off");
    await user.type(input, operatorKey);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/operations/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operatorKey })
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain(operatorKey);
    expect(input).toHaveValue("");
    expect(router.replace).toHaveBeenCalledWith(
      "/operations/collection-monitor"
    );
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("shows a generic error and clears a rejected key", async () => {
    const operatorKey = "wrong-secret-that-is-at-least-32-characters";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    );
    const user = userEvent.setup();

    render(<OperatorLoginForm />);
    const input = screen.getByLabelText("Operator key");
    await user.type(input, operatorKey);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Authentication failed."
    );
    expect(input).toHaveValue("");
    expect(screen.queryByText(operatorKey)).not.toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
