// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";

import {
  clearStoredCredentials,
  credentialStorageKey,
  writeStoredCredentials
} from "./api-credentials";
import {
  earlyDossierReadScript,
  fetchFirstDossierRead,
  takeEarlyDossierRead
} from "./early-dossier-read";

const path = "/api/dossiers/eu/silvermoon/ryii";
const schema = {
  safeParse(value: unknown) {
    return value && typeof value === "object" && "name" in value
      ? { success: true as const, data: value as { name: string } }
      : { success: false as const };
  }
};

/** Runs the shell's script as the browser would, at global scope. */
function runScript(script = earlyDossierReadScript(path)) {
  new Function(script)();
}

afterEach(() => {
  void takeEarlyDossierRead(path);
  clearStoredCredentials();
  vi.unstubAllGlobals();
});

it("starts the read the client would send, and hands it over once", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ name: "Ryii" }));
  vi.stubGlobal("fetch", fetchMock);

  runScript();

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledWith(path, {
    cache: "no-store",
    headers: {}
  });
  const early = takeEarlyDossierRead(path);
  expect(early).not.toBeNull();
  await expect(early).resolves.toBeInstanceOf(Response);
  expect(takeEarlyDossierRead(path)).toBeNull();
});

it("leaves a visitor with saved credentials to the client", () => {
  writeStoredCredentials({
    blizzardClientId: "",
    blizzardClientSecret: "",
    raiderIoAccessKey: "rio-key",
    wclClientId: "",
    wclClientSecret: ""
  });
  const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
  vi.stubGlobal("fetch", fetchMock);

  runScript();

  expect(fetchMock).not.toHaveBeenCalled();
  expect(takeEarlyDossierRead(path)).toBeNull();
});

it("still starts the read when every saved credential has been cleared", () => {
  writeStoredCredentials({
    blizzardClientId: "",
    blizzardClientSecret: "",
    raiderIoAccessKey: "",
    wclClientId: "",
    wclClientSecret: ""
  });
  const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
  vi.stubGlobal("fetch", fetchMock);

  runScript();

  expect(fetchMock).toHaveBeenCalledOnce();
});

it("starts the read when saved credentials cannot be parsed, as the client sends none", () => {
  window.localStorage.setItem(credentialStorageKey, "{not json");
  const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
  vi.stubGlobal("fetch", fetchMock);

  runScript();

  expect(fetchMock).toHaveBeenCalledOnce();
});

it("does not hand one character's read to another character's page", () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));

  runScript();

  expect(takeEarlyDossierRead("/api/dossiers/eu/silvermoon/other")).toBeNull();
  expect(takeEarlyDossierRead(path)).toBeNull();
});

it("keeps a path from closing the script it is written into", () => {
  const script = earlyDossierReadScript("/api/dossiers/eu/x/</script><b>");

  expect(script).not.toContain("</script>");
  expect(script).toContain("\\u003c/script>");
});

it("does not report an early read that failed and was never taken", async () => {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

  runScript();
  await new Promise((resolve) => setTimeout(resolve, 0));

  process.off("unhandledRejection", unhandled);
  expect(unhandled).not.toHaveBeenCalled();
});

it("reads the early response in place of a second request", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ name: "Ryii" }));
  vi.stubGlobal("fetch", fetchMock);
  runScript();

  const result = await fetchFirstDossierRead(path, schema, {
    cache: "no-store"
  });

  expect(result).toMatchObject({ kind: "ok", data: { name: "Ryii" } });
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("reads from the network when the shell started nothing", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ name: "Ryii" }));
  vi.stubGlobal("fetch", fetchMock);

  const result = await fetchFirstDossierRead(path, schema, {
    cache: "no-store"
  });

  expect(result).toMatchObject({ kind: "ok", data: { name: "Ryii" } });
  expect(fetchMock).toHaveBeenCalledWith(path, {
    cache: "no-store",
    headers: {}
  });
});

it("keeps an early refusal a refusal", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { code: "x" } }, { status: 409 })
      )
  );
  runScript();

  const result = await fetchFirstDossierRead(path, schema);

  expect(result.kind).toBe("refused");
  expect(result.response.status).toBe(409);
});
