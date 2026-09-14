import { expect, it } from "vitest";

import { loadWebConfig } from "./config";

it("validates all web runtime secrets and operational limits", () => {
  // Break caught: the web process could start with missing database or weak secrets.
  expect(() => loadWebConfig({})).toThrow();
  expect(
    loadWebConfig({
      DATABASE_URL: "postgresql://slashwho:secret@db.internal/slashwho",
      BOT_API_KEY: "b".repeat(32),
      RATE_LIMIT_HASH_SECRET: "r".repeat(32),
      PUBLIC_READS_PER_MINUTE: "123",
      BLIZZARD_CLIENT_ID: "blizzard-client-id",
      BLIZZARD_CLIENT_SECRET: "blizzard-client-secret"
    })
  ).toMatchObject({
    databaseUrl: "postgresql://slashwho:secret@db.internal/slashwho",
    application: { PUBLIC_READS_PER_MINUTE: 123 }
  });
});

it("does not require Warcraft Logs credentials in the web process", () => {
  // Break caught: web deployments could retain worker-only credentials after evidence collection moved to the worker.
  const environment = {
    DATABASE_URL: "postgresql://slashwho:secret@db.internal/slashwho",
    BOT_API_KEY: "b".repeat(32),
    RATE_LIMIT_HASH_SECRET: "r".repeat(32),
    BLIZZARD_CLIENT_ID: "blizzard-client-id",
    BLIZZARD_CLIENT_SECRET: "blizzard-client-secret"
  };

  const config = loadWebConfig(environment);
  expect(config.dossier.blizzardClientId).toBe("blizzard-client-id");
});
