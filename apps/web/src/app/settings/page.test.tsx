// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import SettingsPage from "./page";
import {
  clearStoredCredentials,
  readStoredCredentials
} from "../../lib/api-credentials";

afterEach(() => {
  cleanup();
  clearStoredCredentials();
});

describe("SettingsPage", () => {
  it("saves entered credentials to local storage", async () => {
    render(<SettingsPage />);
    const [blizzardClientId] = screen.getAllByLabelText("Client ID");
    await userEvent.type(blizzardClientId, "user-id");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(readStoredCredentials().blizzardClientId).toBe("user-id");
  });

  it("clears saved credentials from local storage", async () => {
    render(<SettingsPage />);
    const [blizzardClientId] = screen.getAllByLabelText("Client ID");
    await userEvent.type(blizzardClientId, "user-id");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(readStoredCredentials().blizzardClientId).toBe("user-id");

    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(readStoredCredentials().blizzardClientId).toBe("");
    expect(blizzardClientId).toHaveValue("");
  });
});
