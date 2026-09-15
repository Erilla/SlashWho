import { describe, expect, it } from "vitest";

import { readCredentialOverrides } from "./credential-headers";
import { loadWebConfig } from "./config";

const config = loadWebConfig({
  DATABASE_URL: "postgresql://slashwho:secret@db.internal/slashwho",
  BOT_API_KEY: "b".repeat(32),
  RATE_LIMIT_HASH_SECRET: "r".repeat(32),
  BLIZZARD_CLIENT_ID: "blizzard-client-id",
  BLIZZARD_CLIENT_SECRET: "blizzard-client-secret",
  EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64)
});

describe("readCredentialOverrides", () => {
  it("returns no overrides when no credential headers are present", () => {
    // Break caught: a route could construct gateways even when a visitor
    // supplied no credentials, spending unnecessary work per request.
    const overrides = readCredentialOverrides(new Headers(), config);
    expect(overrides.blizzard).toBeUndefined();
    expect(overrides.raiderio).toBeUndefined();
    expect(overrides.wclCredentials).toBeUndefined();
  });

  it("builds a Blizzard gateway when both header values are present", () => {
    // Break caught: a visitor-supplied Blizzard client id/secret pair could
    // be silently ignored instead of overriding the shared gateway.
    const headers = new Headers({
      "x-blizzard-client-id": "user-id",
      "x-blizzard-client-secret": "user-secret"
    });
    const overrides = readCredentialOverrides(headers, config);
    expect(overrides.blizzard).toBeDefined();
  });

  it("ignores a Blizzard header pair with only one value present", () => {
    // Break caught: a partial credential pair could be treated as complete
    // and used to build a gateway with an undefined secret.
    const headers = new Headers({ "x-blizzard-client-id": "user-id" });
    const overrides = readCredentialOverrides(headers, config);
    expect(overrides.blizzard).toBeUndefined();
  });

  it("passes the Raider.IO access key through unchanged", () => {
    // Break caught: a visitor-supplied Raider.IO access key could be dropped
    // instead of being attached to outgoing requests.
    const headers = new Headers({ "x-raiderio-access-key": "user-key" });
    const overrides = readCredentialOverrides(headers, config);
    expect(overrides.raiderio).toBeDefined();
  });

  it("returns WCL credentials as plain data, not a gateway", () => {
    // Break caught: WCL credentials could be built into a gateway here even
    // though only the worker (Task 7) has the decrypted values it needs.
    const headers = new Headers({
      "x-wcl-client-id": "user-id",
      "x-wcl-client-secret": "user-secret"
    });
    const overrides = readCredentialOverrides(headers, config);
    expect(overrides.wclCredentials).toEqual({
      clientId: "user-id",
      clientSecret: "user-secret"
    });
  });
});
