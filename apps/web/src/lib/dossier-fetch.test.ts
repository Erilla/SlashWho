// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";

import {
  clearStoredCredentials,
  writeStoredCredentials
} from "./api-credentials";
import { dossierFetch } from "./dossier-fetch";

afterEach(() => {
  clearStoredCredentials();
  vi.unstubAllGlobals();
});

it("keeps the caller's headers alongside the saved credentials", async () => {
  writeStoredCredentials({
    blizzardClientId: "",
    blizzardClientSecret: "",
    raiderIoAccessKey: "rio-key",
    wclClientId: "",
    wclClientSecret: ""
  });
  const fetchMock = vi.fn((input: string) =>
    Promise.resolve(
      input === "/api/account/session"
        ? Response.json({ account: null })
        : Response.json({})
    )
  );
  vi.stubGlobal("fetch", fetchMock);

  await dossierFetch("/api/dossiers/eu/silvermoon/ryii/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" }
  });

  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/dossiers/eu/silvermoon/ryii/refresh",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-raiderio-access-key": "rio-key"
      }
    }
  );
});

it("sends no credential headers when none are saved", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
  vi.stubGlobal("fetch", fetchMock);

  await dossierFetch("/api/dossiers/jobs/job", { cache: "no-store" });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/dossiers/jobs/job", {
    cache: "no-store",
    headers: {}
  });
});
