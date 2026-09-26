// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearStoredCredentials,
  writeStoredCredentials
} from "./api-credentials";
import {
  dossierApiPath,
  dossierFetch,
  dossierJobApiPath,
  fetchDossierApi
} from "./dossier-api";

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

it("encodes every segment of a dossier API path", () => {
  expect(
    dossierApiPath(
      { region: "eu", realm: "tarren-mill", name: "rÿii" },
      "tiers",
      "liberation of undermine",
      "search"
    )
  ).toBe(
    "/api/dossiers/eu/tarren-mill/r%C3%BFii/tiers/liberation%20of%20undermine/search"
  );
  expect(dossierJobApiPath("job/1")).toBe("/api/dossiers/jobs/job%2F1");
});

describe("fetchDossierApi", () => {
  const schema = {
    safeParse: (value: unknown) =>
      typeof value === "object" && value !== null && "mode" in value
        ? { success: true as const, data: value as { mode: string } }
        : { success: false as const }
  };

  it("parses a successful body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ mode: "full" }))
    );
    await expect(
      fetchDossierApi("/api/dossiers/x", schema)
    ).resolves.toMatchObject({
      kind: "ok",
      data: { mode: "full" }
    });
  });

  it("keeps a refusal's body for its error", async () => {
    const body = { error: { code: "rate_limited", message: "Slow down." } };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json(body, { status: 429 }))
    );
    const result = await fetchDossierApi("/api/dossiers/x", schema);
    expect(result).toMatchObject({ kind: "refused", body });
    expect(result.response.status).toBe(429);
  });

  it("reports a successful body the schema rejects as unexpected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));
    await expect(
      fetchDossierApi("/api/dossiers/x", schema)
    ).resolves.toMatchObject({
      kind: "unexpected"
    });
  });

  it("parses a status the caller names as an answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ mode: "busy" }, { status: 409 }))
    );
    await expect(
      fetchDossierApi("/api/dossiers/x", schema, {}, { answers: [409] })
    ).resolves.toMatchObject({ kind: "ok", data: { mode: "busy" } });
  });

  it("rejects when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(fetchDossierApi("/api/dossiers/x", schema)).rejects.toThrow(
      "offline"
    );
  });
});
