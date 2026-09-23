import { expect, it } from "vitest";

import { loadWebConfig } from "./config";

const validEnv = {
  DATABASE_URL: "postgresql://slashwho:secret@db.internal/slashwho",
  BOT_API_KEY: "b".repeat(32),
  RATE_LIMIT_HASH_SECRET: "r".repeat(32),
  OPERATOR_ORIGIN: "https://operators.example.test",
  OPERATOR_SESSION_HASH_SECRET: "s".repeat(32),
  BLIZZARD_CLIENT_ID: "blizzard-client-id",
  BLIZZARD_CLIENT_SECRET: "blizzard-client-secret",
  EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64)
};

it("validates all web runtime secrets and operational limits", () => {
  // Break caught: the web process could start with missing database or weak secrets.
  expect(() => loadWebConfig({})).toThrow();
  expect(
    loadWebConfig({
      ...validEnv,
      PUBLIC_READS_PER_MINUTE: "123"
    })
  ).toMatchObject({
    databaseUrl: "postgresql://slashwho:secret@db.internal/slashwho",
    application: { PUBLIC_READS_PER_MINUTE: 123 }
  });
});

it("validates the dedicated account credential key", () => {
  expect(
    loadWebConfig(validEnv).accountCredentialEncryptionKey
  ).toBeUndefined();
  expect(
    loadWebConfig({
      ...validEnv,
      ACCOUNT_CREDENTIAL_ENCRYPTION_KEY: "b".repeat(64)
    }).accountCredentialEncryptionKey
  ).toEqual(Buffer.from("b".repeat(64), "hex"));
  expect(() =>
    loadWebConfig({ ...validEnv, ACCOUNT_CREDENTIAL_ENCRYPTION_KEY: "short" })
  ).toThrow("invalid_credential_encryption_key");
  expect(() =>
    loadWebConfig({
      ...validEnv,
      ACCOUNT_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64)
    })
  ).toThrow("account_credential_encryption_key_must_be_distinct");
});

it.each([
  undefined,
  "",
  "http://localhost:3000",
  "https://example.test/",
  "https://user:pass@example.test",
  "https://example.test/path",
  "https://example.test?x=1",
  "https://example.test#fragment",
  " https://example.test",
  "https://EXAMPLE.test"
])("rejects a non-exact HTTPS operator origin: %s", (origin) => {
  expect(() => loadWebConfig({ ...validEnv, OPERATOR_ORIGIN: origin })).toThrow(
    "invalid_operator_origin"
  );
});

it("accepts only the dynamic loopback HTTP origin under the development runtime", () => {
  expect(
    loadWebConfig({
      ...validEnv,
      NODE_ENV: "development",
      OPERATOR_ORIGIN: "http://127.0.0.1:41053"
    }).operatorAuth.origin
  ).toBe("http://127.0.0.1:41053");
  expect(() =>
    loadWebConfig({
      ...validEnv,
      NODE_ENV: "production",
      OPERATOR_ORIGIN: "http://127.0.0.1:41053"
    })
  ).toThrow("invalid_operator_origin");
});

it.each([undefined, "", "s".repeat(31), " ".repeat(32)])(
  "requires a strong dedicated operator session secret",
  (secret) => {
    expect(() =>
      loadWebConfig({ ...validEnv, OPERATOR_SESSION_HASH_SECRET: secret })
    ).toThrow("invalid_operator_session_hash_secret");
  }
);

it("exposes the exact configured operator origin and dedicated session secret", () => {
  expect(loadWebConfig(validEnv).operatorAuth).toEqual({
    origin: "https://operators.example.test",
    sessionHashSecret: "s".repeat(32)
  });
});

it("does not require Warcraft Logs credentials in the web process", () => {
  // Break caught: a web deployment without Warcraft Logs credentials would
  // refuse to start, when only character-ID URL resolution needs them.
  const config = loadWebConfig(validEnv);
  expect(config.dossier.blizzardClientId).toBe("blizzard-client-id");
  expect(config.dossier.warcraftLogs).toBeUndefined();
});

it("reads optional Warcraft Logs credentials for character-ID resolution", () => {
  expect(
    loadWebConfig({
      ...validEnv,
      WARCRAFT_LOGS_CLIENT_ID: " wcl-client-id ",
      WARCRAFT_LOGS_CLIENT_SECRET: "wcl-client-secret",
      WARCRAFT_LOGS_BASE_URL: "http://127.0.0.1:4321"
    }).dossier.warcraftLogs
  ).toEqual({
    clientId: "wcl-client-id",
    clientSecret: "wcl-client-secret",
    baseUrl: "http://127.0.0.1:4321"
  });
});

it.each([
  { WARCRAFT_LOGS_CLIENT_ID: "wcl-client-id" },
  { WARCRAFT_LOGS_CLIENT_SECRET: "wcl-client-secret" },
  { WARCRAFT_LOGS_CLIENT_ID: "wcl-client-id", WARCRAFT_LOGS_CLIENT_SECRET: " " }
])("rejects half a Warcraft Logs credential pair: %o", (partial) => {
  // Break caught: a typo in one variable would silently disable ID URLs.
  expect(() => loadWebConfig({ ...validEnv, ...partial })).toThrow(
    "incomplete_warcraft_logs_credentials"
  );
});

it("throws when EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY is missing", () => {
  // Break caught: the web process could start without the key it needs to
  // encrypt a visitor-supplied WarcraftLogs credential before queuing it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY, ...rest } = validEnv;
  expect(() => loadWebConfig(rest)).toThrow(
    "evidence_job_credential_encryption_key_required"
  );
});

it("throws when EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY is malformed", () => {
  // Break caught: a truncated or non-hex key could pass through unvalidated
  // and fail unpredictably at encrypt/decrypt time instead of at startup.
  expect(() =>
    loadWebConfig({
      ...validEnv,
      EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY: "not-a-valid-key"
    })
  ).toThrow("invalid_credential_encryption_key");
});

it("reads an optional Raider.IO access key and trims it", () => {
  // Break caught: a configured server key could be ignored, leaving the web
  // process on the anonymous rate limit it was configured to escape.
  expect(
    loadWebConfig({ ...validEnv, RAIDER_IO_ACCESS_KEY: "  server-key  " })
      .dossier.raiderIoAccessKey
  ).toBe("server-key");
});

it("leaves the Raider.IO access key undefined when it is absent or blank", () => {
  // Break caught: an unset or whitespace-only key could become an empty
  // string and be sent as access_key=, breaking anonymous access for local
  // dev and contributors without a key.
  expect(loadWebConfig(validEnv).dossier.raiderIoAccessKey).toBeUndefined();
  expect(
    loadWebConfig({ ...validEnv, RAIDER_IO_ACCESS_KEY: "   " }).dossier
      .raiderIoAccessKey
  ).toBeUndefined();
});
