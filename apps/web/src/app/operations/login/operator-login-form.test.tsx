// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
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
  it("submits the login and credential in a JSON body and navigates to the monitor", async () => {
    const credential = "operator-secret-that-is-at-least-32-characters";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<OperatorLoginForm />);
    await user.type(screen.getByLabelText("Login"), "Ryan");
    const input = screen.getByLabelText("Credential");
    expect(input).toHaveAttribute("autocomplete", "off");
    await user.type(input, credential);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/operations/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "Ryan", credential })
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain(credential);
    expect(input).toHaveValue("");
    expect(router.replace).toHaveBeenCalledWith(
      "/operations/collection-monitor"
    );
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("shows a generic error and clears a rejected credential", async () => {
    const credential = "wrong-secret-that-is-at-least-32-characters";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    );
    const user = userEvent.setup();

    render(<OperatorLoginForm />);
    await user.type(screen.getByLabelText("Login"), "Ryan");
    const input = screen.getByLabelText("Credential");
    await user.type(input, credential);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Authentication failed."
    );
    expect(input).toHaveValue("");
    expect(screen.queryByText(credential)).not.toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });
  it("clears the credential while the request is still pending", async () => {
    let settle!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            settle = resolve;
          })
      )
    );
    const user = userEvent.setup();
    render(<OperatorLoginForm />);
    await user.type(screen.getByLabelText("Login"), "Ryan");
    const input = screen.getByLabelText("Credential");
    await user.type(input, "credential-stays-out-of-state");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    await act(async () => settle(new Response(null, { status: 204 })));
  });
});
