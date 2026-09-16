import { describe, expect, it } from "vitest";

import { refreshMode } from "./refresh-mode";

const cooldownMs = 15 * 60 * 1000;
const at = new Date("2026-09-16T12:00:00.000Z");

describe("refreshMode", () => {
  it("collects everything when nothing has been collected yet", () => {
    expect(refreshMode(null, at, cooldownMs)).toBe("full");
  });

  it("collects everything once the cooldown has elapsed", () => {
    const lastCompletedAt = new Date("2026-09-16T11:44:00.000Z");
    expect(refreshMode(lastCompletedAt, at, cooldownMs)).toBe("full");
  });

  it("only looks for new kills while the cooldown is running", () => {
    // Break caught: pressing refresh inside the cooldown must still do
    // something useful rather than refusing, but it must not re-scan a whole
    // history against a rate-limited upstream.
    const lastCompletedAt = new Date("2026-09-16T11:50:00.000Z");
    expect(refreshMode(lastCompletedAt, at, cooldownMs)).toBe("light");
  });

  it("treats a collection dated in the future as still cooling down", () => {
    // Clock skew between web and worker must not open the expensive path.
    const lastCompletedAt = new Date("2026-09-16T12:05:00.000Z");
    expect(refreshMode(lastCompletedAt, at, cooldownMs)).toBe("light");
  });
});
