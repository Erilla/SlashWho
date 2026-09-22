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
            "tests/e2e/support/**/*.test.ts"
          ],
          name: "unit"
        }
      },
      {
        test: {
          fileParallelism: false,
          include: ["tests/integration/**/*.test.ts"],
          name: "integration",
          testTimeout: 30_000,
          hookTimeout: 60_000
        }
      }
    ]
  }
});
