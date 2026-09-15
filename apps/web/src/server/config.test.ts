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
  const { EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY, ...rest } = validEnv;
  expect(() => loadWebConfig(rest)).toThrow(
    "evidence_job_credential_encryption_key_required"
  );
});
