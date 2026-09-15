import { describe, expect, it } from "vitest";

import { queueWaitMs } from "./queue-wait";

describe("queueWaitMs", () => {
  it("measures the wait", () => {
    expect(
      queueWaitMs(
        "2026-09-15T10:00:00.000Z",
        new Date("2026-09-15T10:00:02.500Z")
      )
    ).toBe(2_500);
  });

  it("returns null without an enqueue time", () => {
    expect(queueWaitMs(undefined, new Date())).toBeNull();
  });

  it("returns null for an unparseable enqueue time", () => {
    expect(queueWaitMs("not-a-date", new Date())).toBeNull();
  });

  it("clamps clock skew to zero", () => {
    expect(
      queueWaitMs(
        "2026-09-15T10:00:05.000Z",
        new Date("2026-09-15T10:00:00.000Z")
      )
    ).toBe(0);
  });
});
