import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        test: {
          maxWorkers: 2,
          include: [
            "apps/**/src/**/*.test.{ts,tsx}",
            "packages/**/src/**/*.test.ts",
            "scripts/**/*.test.mts",
            "tests/unit/**/*.test.ts",
            "tests/e2e/support/**/*.test.ts"
          ],
          name: "unit"
        }
      },
      {
        test: {
          // Files run in parallel: each starts its own PostgreSQL container in
          // beforeAll and each runs in its own process, so they share neither
          // a database nor process.env. Tests within a file still run in order.
          // vitest's default of one worker fewer than the vCPUs, three on CI,
          // is deliberate: the runner is CPU-bound with each file's PostgreSQL
          // alongside, and four workers measured 10s slower (#649).
          include: ["tests/integration/**/*.test.ts"],
          name: "integration",
          testTimeout: 30_000,
          hookTimeout: 60_000
        }
      }
    ]
  }
});
