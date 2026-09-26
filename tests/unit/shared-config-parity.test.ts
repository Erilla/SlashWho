import { describe, expect, it } from "vitest";

import { loadWebConfig } from "../../apps/web/src/server/config";
import { loadWorkerConfig } from "../../apps/worker/src/config";

// Everything either service requires, so each case below varies only the
// shared keys it names.
const baseEnvironment = {
  DATABASE_URL: "postgresql://slashwho:secret@db.internal/slashwho",
  BOT_API_KEY: "b".repeat(32),
  RATE_LIMIT_HASH_SECRET: "r".repeat(32),
  OPERATOR_ORIGIN: "https://operators.example.test",
  OPERATOR_SESSION_HASH_SECRET: "s".repeat(32),
  BLIZZARD_CLIENT_ID: "blizzard-client-id",
  BLIZZARD_CLIENT_SECRET: "blizzard-client-secret",
  BLIZZARD_SWEEP_REQUEST_CAP: "300",
  WARCRAFT_LOGS_CLIENT_ID: "warcraft-logs-client-id",
  WARCRAFT_LOGS_CLIENT_SECRET: "warcraft-logs-client-secret",
  EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64)
};

function sharedValues(environment: Record<string, string | undefined>) {
  const web = loadWebConfig(environment);
  const worker = loadWorkerConfig(environment);
  return {
    web: {
      databaseUrl: web.databaseUrl,
      raiderIoBaseUrl: web.dossier.raiderIoBaseUrl,
      raiderIoTimeoutMs: web.dossier.raiderIoTimeoutMs,
      raiderIoAccessKey: web.dossier.raiderIoAccessKey,
      blizzardClientId: web.dossier.blizzardClientId,
      blizzardClientSecret: web.dossier.blizzardClientSecret,
      freshnessHours: web.application.FRESHNESS_HOURS,
      fingerprintSweepCadenceHours:
        web.application.FINGERPRINT_SWEEP_CADENCE_HOURS,
      negativeCacheTtlMs: web.application.NEGATIVE_CACHE_TTL_MS,
      evidenceJobCredentialEncryptionKey:
        web.dossier.evidenceJobCredentialEncryptionKey,
      accountCredentialEncryptionKey: web.accountCredentialEncryptionKey
    },
    worker: {
      databaseUrl: worker.databaseUrl,
      raiderIoBaseUrl: worker.raiderIoBaseUrl,
      raiderIoTimeoutMs: worker.raiderIoTimeoutMs,
      raiderIoAccessKey: worker.raiderIoAccessKey,
      blizzardClientId: worker.blizzardClientId,
      blizzardClientSecret: worker.blizzardClientSecret,
      freshnessHours: worker.evidenceFreshnessHours,
      fingerprintSweepCadenceHours: worker.fingerprintSweepCadenceHours,
      negativeCacheTtlMs: worker.negativeCacheTtlMs,
      evidenceJobCredentialEncryptionKey:
        worker.evidenceJobCredentialEncryptionKey,
      accountCredentialEncryptionKey: worker.accountCredentialEncryptionKey
    }
  };
}

function rejection(load: () => unknown): string | undefined {
  try {
    load();
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe("configuration shared by the web and the worker", () => {
  it.each([
    ["defaults", {}],
    [
      "authored values",
      {
        DATABASE_URL: " postgres://slashwho@db.internal/slashwho ",
        RAIDER_IO_BASE_URL: " http://127.0.0.1:4100 ",
        RAIDER_IO_TIMEOUT_MS: "2500",
        RAIDER_IO_ACCESS_KEY: " raider-io-key ",
        BLIZZARD_CLIENT_ID: " padded-id ",
        FRESHNESS_HOURS: "1.5",
        FINGERPRINT_SWEEP_CADENCE_HOURS: "0.5",
        NEGATIVE_CACHE_TTL_MS: "60000",
        ACCOUNT_CREDENTIAL_ENCRYPTION_KEY: "c".repeat(64)
      }
    ],
    [
      "blank values",
      {
        RAIDER_IO_BASE_URL: "",
        RAIDER_IO_TIMEOUT_MS: "",
        RAIDER_IO_ACCESS_KEY: " ",
        FRESHNESS_HOURS: "",
        FINGERPRINT_SWEEP_CADENCE_HOURS: "",
        NEGATIVE_CACHE_TTL_MS: "",
        ACCOUNT_CREDENTIAL_ENCRYPTION_KEY: ""
      }
    ]
  ])("reads %s identically", (_, overrides) => {
    // Break caught (#569): the two services parsed these keys with their own
    // helpers, so FRESHNESS_HOURS=1.5 or a blank limit booted one of them and
    // crashed the other, and a padded value could differ between them.
    const { web, worker } = sharedValues({ ...baseEnvironment, ...overrides });
    expect(worker).toEqual(web);
  });

  it.each([
    ["DATABASE_URL", "mysql://db/slashwho"],
    ["DATABASE_URL", ""],
    ["RAIDER_IO_TIMEOUT_MS", "0"],
    ["RAIDER_IO_TIMEOUT_MS", "1.5"],
    ["BLIZZARD_CLIENT_ID", " "],
    ["BLIZZARD_CLIENT_SECRET", undefined],
    ["FRESHNESS_HOURS", "0"],
    ["FINGERPRINT_SWEEP_CADENCE_HOURS", "-1"],
    ["NEGATIVE_CACHE_TTL_MS", "1.5"],
    ["EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY", "short"],
    ["ACCOUNT_CREDENTIAL_ENCRYPTION_KEY", "a".repeat(64)]
  ])("rejects %s=%j with the same code in both", (name, value) => {
    const environment = { ...baseEnvironment, [name]: value };
    const webCode = rejection(() => loadWebConfig(environment));
    expect(webCode).toBeDefined();
    expect(rejection(() => loadWorkerConfig(environment))).toBe(webCode);
  });
});
