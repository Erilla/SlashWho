import { expect, it } from "vitest";

import { loadWebConfig } from "./config";

const validEnv = {
  DATABASE_URL: "postgresql://slashwho:secret@db.internal/slashwho",
  BOT_API_KEY: "b".repeat(32),
  RATE_LIMIT_HASH_SECRET: "r".repeat(32),
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

it("does not require Warcraft Logs credentials in the web process", () => {
  // Break caught: web deployments could retain worker-only credentials after evidence collection moved to the worker.
  const config = loadWebConfig(validEnv);
  expect(config.dossier.blizzardClientId).toBe("blizzard-client-id");
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
