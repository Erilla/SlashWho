// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredCredentials,
  credentialHeaders,
  credentialHeadersForRequest,
  readStoredCredentials,
  writeStoredCredentials
} from "./api-credentials";

afterEach(() => {
  clearStoredCredentials();
  vi.unstubAllGlobals();
});

describe("api-credentials", () => {
  it("omits browser keys for signed-in sessions and on session lookup failure", async () => {
    writeStoredCredentials({
      blizzardClientId: "old",
      blizzardClientSecret: "other-account",
      raiderIoAccessKey: "",
      wclClientId: "",
      wclClientSecret: ""
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ account: { email: "alice@example.com" } })
        )
    );
    expect(await credentialHeadersForRequest()).toEqual({});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await credentialHeadersForRequest()).toEqual({});
  });
  it("returns empty strings when nothing is stored", () => {
    expect(readStoredCredentials()).toEqual({
      blizzardClientId: "",
      blizzardClientSecret: "",
      raiderIoAccessKey: "",
      wclClientId: "",
      wclClientSecret: ""
    });
  });

  it("round-trips written credentials", () => {
    writeStoredCredentials({
      blizzardClientId: "id",
      blizzardClientSecret: "secret",
      raiderIoAccessKey: "key",
      wclClientId: "wid",
      wclClientSecret: "wsecret"
    });
    expect(readStoredCredentials()).toEqual({
      blizzardClientId: "id",
      blizzardClientSecret: "secret",
      raiderIoAccessKey: "key",
      wclClientId: "wid",
      wclClientSecret: "wsecret"
    });
  });

  it("omits headers for empty fields and includes headers for filled ones", () => {
    const headers = credentialHeaders({
      blizzardClientId: "id",
      blizzardClientSecret: "secret",
      raiderIoAccessKey: "",
      wclClientId: "",
      wclClientSecret: ""
    });
    expect(headers).toEqual({
      "x-blizzard-client-id": "id",
      "x-blizzard-client-secret": "secret"
    });
  });
});
