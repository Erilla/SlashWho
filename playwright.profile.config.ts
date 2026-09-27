import { defineConfig } from "playwright/test";

import e2e from "./playwright.config";

/**
 * The dossier load profiler (#646): `corepack pnpm profile:dossier`. Same
 * global setup, fakes and production build as `test:e2e`, but its own test
 * directory, so the gate never runs it and it never runs the gate.
 */
export default defineConfig({
  ...e2e,
  testDir: "./tests/profile",
  testMatch: "**/*.profile.ts",
  // Each warm scenario makes 21 fresh-context loads, and the gathering one
  // waits on the worker and the page's poll backoff for every load.
  timeout: 10 * 60_000,
  reporter: "list",
  use: { ...e2e.use, trace: "off", screenshot: "off" }
});
