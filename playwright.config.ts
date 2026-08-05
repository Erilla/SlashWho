import { defineConfig, devices } from "playwright/test";

const webBaseUrl = "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  // The critical journey waits on real worker discovery behind a client poll
  // backoff that caps at 10s, so the default 30s per-test budget cannot absorb a
  // cold CI runner.
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  globalSetup: "./tests/e2e/support/global-setup.ts",
  use: {
    baseURL: webBaseUrl,
    extraHTTPHeaders: { "x-real-ip": "127.0.0.1" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
