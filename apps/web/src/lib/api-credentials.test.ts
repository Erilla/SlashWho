// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearStoredCredentials,
  credentialHeaders,
  readStoredCredentials,
  writeStoredCredentials
} from "./api-credentials";

afterEach(() => {
  clearStoredCredentials();
});

describe("api-credentials", () => {
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
