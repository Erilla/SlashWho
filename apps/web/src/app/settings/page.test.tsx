// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  it.each(["unknown", "signed-in"])(
    "does not save a stale signed-out form after session refresh becomes %s",
    async (nextSession) => {
      let resolveSave!: (response: {
        ok: boolean;
        json(): Promise<{ account: null }>;
      }) => void;
      const pendingSave = new Promise<{
        ok: boolean;
        json(): Promise<{ account: null }>;
      }>((resolve) => {
        resolveSave = resolve;
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ account: null })
        })
        .mockImplementationOnce(() => pendingSave)
        .mockResolvedValueOnce(
          nextSession === "unknown"
            ? { ok: false, status: 500 }
            : {
                ok: true,
                json: async () => ({
                  account: {
                    email: "b@example.test",
                    passwordChangeRequired: false
                  }
                })
              }
        )
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            providers: [
              { provider: "blizzard", present: false, version: 0 },
              { provider: "raiderio", present: false, version: 0 },
              { provider: "warcraftlogs", present: false, version: 0 }
            ]
          })
        });
      vi.stubGlobal("fetch", fetchMock);
      render(<SettingsPage />);
      const [clientId] = await screen.findAllByLabelText("Client ID");
      await userEvent.type(clientId!, "old-secret-id");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      window.dispatchEvent(new Event("focus"));
      if (nextSession === "unknown")
        await screen.findByRole("button", { name: "Retry session check" });
      else await screen.findAllByText("No account key saved");
      await act(async () =>
        resolveSave({ ok: true, json: async () => ({ account: null }) })
      );
      expect(readStoredCredentials().blizzardClientId).toBe("");
      expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
    }
  );

  it.each(["rejected", "http-500"])(
    "keeps browser storage locked when session lookup is %s",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockImplementation(() =>
            failure === "rejected"
              ? Promise.reject(new Error("offline"))
              : Promise.resolve({ ok: false, status: 500 })
          )
      );
      render(<SettingsPage />);
      expect(
        await screen.findByRole("button", { name: "Retry session check" })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Save" })
      ).not.toBeInTheDocument();
      expect(readStoredCredentials().blizzardClientId).toBe("");
    }
  );

  it.each(["slashwho:account-session-changed", "focus"])(
    "drops old account forms on %s after switching accounts with matching slot versions",
    async (eventName) => {
      writeStoredCredentials({
        blizzardClientId: "A-browser-id",
        blizzardClientSecret: "A-browser-secret",
        raiderIoAccessKey: "",
        wclClientId: "",
        wclClientSecret: ""
      });
      const account = (email: string) => ({
        ok: true,
        json: async () => ({
          account: { email, passwordChangeRequired: false }
        })
      });
      const slots = {
        ok: true,
        json: async () => ({
          providers: [
            { provider: "blizzard", present: false, version: 0 },
            { provider: "raiderio", present: false, version: 0 },
            { provider: "warcraftlogs", present: false, version: 0 }
          ]
        })
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(account("a@example.test"))
        .mockResolvedValueOnce(slots)
        .mockResolvedValueOnce(account("b@example.test"))
        .mockResolvedValueOnce(slots);
      vi.stubGlobal("fetch", fetchMock);
      render(<SettingsPage />);
      await screen.findByRole("button", { name: "Import browser copy" });
      await userEvent.type(
        screen.getAllByLabelText("Client ID")[0]!,
        "A-form-value"
      );
      window.dispatchEvent(new Event(eventName));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
      await screen.findByRole("button", { name: "Import browser copy" });
      expect(screen.getAllByLabelText("Client ID")[0]).toHaveValue("");
      expect(
        fetchMock.mock.calls.some((call) => call[1]?.method === "PUT")
      ).toBe(false);
      expect(readStoredCredentials().blizzardClientSecret).toBe(
        "A-browser-secret"
      );
    }
  );

  it("rechecks the live account before importing and retains the browser copy on a switch", async () => {
    writeStoredCredentials({
      blizzardClientId: "A-id",
      blizzardClientSecret: "A-secret",
      raiderIoAccessKey: "",
      wclClientId: "",
      wclClientSecret: ""
    });
    const account = (email: string) => ({
      ok: true,
      json: async () => ({ account: { email, passwordChangeRequired: false } })
    });
    const slots = {
      ok: true,
      json: async () => ({
        providers: [
          { provider: "blizzard", present: false, version: 0 },
          { provider: "raiderio", present: false, version: 0 },
          { provider: "warcraftlogs", present: false, version: 0 }
        ]
      })
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(account("a@example.test"))
      .mockResolvedValueOnce(slots)
      .mockResolvedValueOnce(account("b@example.test"))
      .mockResolvedValueOnce(account("b@example.test"))
      .mockResolvedValueOnce(slots);
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Import browser copy" })
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PUT")).toBe(
      false
    );
    expect(readStoredCredentials().blizzardClientSecret).toBe("A-secret");
  });

  it("retains browser credentials when a save request rejects", async () => {
    writeStoredCredentials({
      blizzardClientId: "id",
      blizzardClientSecret: "secret",
      raiderIoAccessKey: "",
      wclClientId: "",
      wclClientSecret: ""
    });
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === "PUT")
          return Promise.reject(new Error("offline"));
        if (url === "/api/account/session")
          return Promise.resolve({
            ok: true,
            json: async () => ({
              account: {
                email: "a@example.test",
                passwordChangeRequired: false
              }
            })
          });
        return Promise.resolve({
          ok: true,
          json: async () => ({
            providers: [
              { provider: "blizzard", present: false, version: 0 },
              { provider: "raiderio", present: false, version: 0 },
              { provider: "warcraftlogs", present: false, version: 0 }
            ]
          })
        });
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Import browser copy" })
    );
    expect(
      await screen.findByText(
        "Could not save this provider. Check your connection and try again."
      )
    ).toBeInTheDocument();
    expect(readStoredCredentials().blizzardClientSecret).toBe("secret");
  });

  it("retains the account slot and browser copy when DELETE rejects", async () => {
    writeStoredCredentials({
      blizzardClientId: "browser-id",
      blizzardClientSecret: "browser-secret",
      raiderIoAccessKey: "",
      wclClientId: "",
      wclClientSecret: ""
    });
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === "DELETE")
          return Promise.reject(new Error("offline"));
        if (url === "/api/account/session")
          return Promise.resolve({
            ok: true,
            json: async () => ({
              account: {
                email: "a@example.test",
                passwordChangeRequired: false
              }
            })
          });
        return Promise.resolve({
          ok: true,
          json: async () => ({
            providers: [
              { provider: "blizzard", present: true, version: 1 },
              { provider: "raiderio", present: false, version: 0 },
              { provider: "warcraftlogs", present: false, version: 0 }
            ]
          })
        });
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove account key" })
    );
    expect(
      await screen.findByText(
        "Could not remove this provider. Check your connection and try again."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Saved in account")).toBeInTheDocument();
    expect(readStoredCredentials().blizzardClientSecret).toBe("browser-secret");
  });

  it("locks account controls when the pre-save session recheck fails", async () => {
    writeStoredCredentials({
      blizzardClientId: "id",
      blizzardClientSecret: "secret",
      raiderIoAccessKey: "",
      wclClientId: "",
      wclClientSecret: ""
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          account: { email: "a@example.test", passwordChangeRequired: false }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          providers: [
            { provider: "blizzard", present: false, version: 0 },
            { provider: "raiderio", present: false, version: 0 },
            { provider: "warcraftlogs", present: false, version: 0 }
          ]
        })
      })
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Import browser copy" })
    );
    expect(
      await screen.findByRole("button", { name: "Retry session check" })
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PUT")).toBe(
      false
    );
    expect(readStoredCredentials().blizzardClientSecret).toBe("secret");
  });

  it("requires an explicit replacement choice and clears a browser copy only after save", async () => {
    writeStoredCredentials({
      blizzardClientId: "browser-id",
      blizzardClientSecret: "browser-secret",
      raiderIoAccessKey: "",
      wclClientId: "",
      wclClientSecret: ""
    });
    let writes = 0;
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, options?: RequestInit) => {
        if (url === "/api/account/session")
          return Promise.resolve({
            ok: true,
            json: async () => ({
              account: {
                email: "a@example.test",
                passwordChangeRequired: false
              }
            })
          });
        if (options?.method === "PUT")
          return Promise.resolve(
            ++writes === 1
              ? { ok: false, status: 503 }
              : { ok: true, json: async () => ({ saved: true }) }
          );
        return Promise.resolve({
          ok: true,
          json: async () => ({
            providers: [
              { provider: "blizzard", present: true, version: 3 },
              { provider: "raiderio", present: false, version: 0 },
              { provider: "warcraftlogs", present: false, version: 0 }
            ]
          })
        });
      });
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
    const writeCall = fetchMock.mock.calls.find(
      (call) => call[1]?.method === "PUT"
    )!;
    expect(JSON.parse(writeCall[1].body)).toMatchObject({
      replace: true,
      expectedVersion: 3,
      expectedAccountEmail: "a@example.test"
    });
  });
  it("saves entered credentials to local storage", async () => {
    render(<SettingsPage />);
    const [blizzardClientId] = await screen.findAllByLabelText("Client ID");
    await userEvent.type(blizzardClientId, "user-id");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(readStoredCredentials().blizzardClientId).toBe("user-id")
    );
  });

  it("clears saved credentials from local storage", async () => {
    render(<SettingsPage />);
    const [blizzardClientId] = await screen.findAllByLabelText("Client ID");
    await userEvent.type(blizzardClientId, "user-id");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(readStoredCredentials().blizzardClientId).toBe("user-id")
    );

    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(readStoredCredentials().blizzardClientId).toBe("");
    expect(blizzardClientId).toHaveValue("");
  });
});
