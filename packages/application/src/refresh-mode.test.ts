import { describe, expect, it } from "vitest";

import { refreshMode } from "./refresh-mode";

const cooldownMs = 15 * 60 * 1000;
const at = new Date("2026-09-16T12:00:00.000Z");

describe("refreshMode", () => {
  it("never derives a rebuild from the cooldown", () => {
    // `rebuild` is chosen by the caller, and only by an operator. A reader
    // pressing Refresh asks for current information, not for a character's
    // entire history to be re-collected.
    expect([
      refreshMode(null, at, cooldownMs),
      refreshMode(new Date("2026-09-16T11:59:00.000Z"), at, cooldownMs),
      refreshMode(new Date("2020-01-01T00:00:00.000Z"), at, cooldownMs)
    ]).not.toContain("rebuild");
  });

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
