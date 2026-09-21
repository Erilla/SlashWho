import { expect, test } from "playwright/test";

import { portsForWorkspace } from "./support/ports";

test("assigns a stable adjacent web and worker port pair per workspace", () => {
  const first = portsForWorkspace("C:/worktrees/one");

  expect(portsForWorkspace("C:/worktrees/one")).toEqual(first);
  expect(first.workerPort).toBe(first.webPort + 1);
  expect(first.webPort).toBeGreaterThanOrEqual(30_000);
  expect(first.workerPort).toBeLessThan(40_001);
});
