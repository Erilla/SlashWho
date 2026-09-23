// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsPage from "./page";
import {
  clearStoredCredentials,
  readStoredCredentials,
  writeStoredCredentials
} from "../../lib/api-credentials";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ account: null }) })
  );
});

afterEach(() => {
  cleanup();
  clearStoredCredentials();
  vi.unstubAllGlobals();
});

describe("SettingsPage", () => {
  it("requires an explicit replacement choice and clears a browser copy only after save", async () => {
    writeStoredCredentials({
      blizzardClientId: "browser-id",
      blizzardClientSecret: "browser-secret",
      raiderIoAccessKey: "",
      wclClientId: "",
      wclClientSecret: ""
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ account: { passwordChangeRequired: false } })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          providers: [
            { provider: "blizzard", present: true, version: 3 },
            { provider: "raiderio", present: false, version: 0 },
            { provider: "warcraftlogs", present: false, version: 0 }
          ]
        })
      })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ saved: true }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsPage />);
    await screen.findByText("Browser copy found.");
    expect(
      screen.queryByRole("button", { name: "Replace with browser copy" })
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Choose replacement" })
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Replace with browser copy" })
    );
    expect(readStoredCredentials().blizzardClientSecret).toBe("browser-secret");
    await userEvent.click(
      screen.getByRole("button", { name: "Replace with browser copy" })
    );
    expect(readStoredCredentials().blizzardClientSecret).toBe("");
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toMatchObject({
      replace: true,
      expectedVersion: 3
    });
  });
  it("saves entered credentials to local storage", async () => {
    render(<SettingsPage />);
    const [blizzardClientId] = await screen.findAllByLabelText("Client ID");
    await userEvent.type(blizzardClientId, "user-id");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(readStoredCredentials().blizzardClientId).toBe("user-id");
  });

  it("clears saved credentials from local storage", async () => {
    render(<SettingsPage />);
    const [blizzardClientId] = await screen.findAllByLabelText("Client ID");
    await userEvent.type(blizzardClientId, "user-id");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(readStoredCredentials().blizzardClientId).toBe("user-id");

    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(readStoredCredentials().blizzardClientId).toBe("");
    expect(blizzardClientId).toHaveValue("");
  });
});
