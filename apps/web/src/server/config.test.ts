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
      WARCRAFT_LOGS_CLIENT_ID: "warcraft-logs-client-id",
      WARCRAFT_LOGS_CLIENT_SECRET: "warcraft-logs-client-secret",
      BLIZZARD_CLIENT_ID: "blizzard-client-id",
      BLIZZARD_CLIENT_SECRET: "blizzard-client-secret"
    })
  ).toMatchObject({
    databaseUrl: "postgresql://slashwho:secret@db.internal/slashwho",
    application: { PUBLIC_READS_PER_MINUTE: 123 }
  });
});

it("requires Warcraft Logs credentials without duplicating dossier request configuration", () => {
  // Break caught: the dossier route could begin third-party work without its
  // server-only credentials or a bounded Warcraft Logs request budget.
  const environment = {
    DATABASE_URL: "postgresql://slashwho:secret@db.internal/slashwho",
    BOT_API_KEY: "b".repeat(32),
    RATE_LIMIT_HASH_SECRET: "r".repeat(32),
    WARCRAFT_LOGS_CLIENT_ID: "warcraft-logs-client-id",
    WARCRAFT_LOGS_CLIENT_SECRET: "warcraft-logs-client-secret",
    BLIZZARD_CLIENT_ID: "blizzard-client-id",
    BLIZZARD_CLIENT_SECRET: "blizzard-client-secret"
  };

  const withoutClientId = {
    ...environment,
    WARCRAFT_LOGS_CLIENT_ID: undefined
  };
  expect(() => loadWebConfig(withoutClientId)).toThrow(
    "warcraft_logs_client_id_required"
  );
  const config = loadWebConfig(environment);
  expect(config.application.DOSSIER_WARCRAFT_LOGS_REQUEST_CAP).toBe(80);
  expect("warcraftLogsRequestCap" in config.dossier).toBe(false);
});
