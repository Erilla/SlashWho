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
          // One worker per vCPU on the 4-vCPU runner, rather than vitest's
          // default of one fewer: the files mostly wait on PostgreSQL.
          maxWorkers: 4,
          include: ["tests/integration/**/*.test.ts"],
          name: "integration",
          testTimeout: 30_000,
          hookTimeout: 60_000
        }
      }
    ]
  }
});
