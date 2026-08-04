import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          include: ["apps/**/src/**/*.test.ts", "packages/**/src/**/*.test.ts"],
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
