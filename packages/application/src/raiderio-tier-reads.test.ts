import { describe, expect, it } from "vitest";

import {
  RAIDER_IO_TIER_READ_TTL_MS,
  raiderIoTierReadOffsetMs,
  raiderIoTierReadSince
} from "./raiderio-tier-reads";

const dayMs = 24 * 60 * 60 * 1_000;

describe("raiderIoTierReadSince", () => {
  it("expires a mark after 90 days plus a stable offset of up to 14 days", () => {
    const key = { region: "eu" as const, realm: "draenor", name: "alfa" };
    const at = new Date("2026-09-28T12:00:00.000Z");
    const offset = raiderIoTierReadOffsetMs(key);

    expect(RAIDER_IO_TIER_READ_TTL_MS).toBe(90 * dayMs);
    expect(offset).toBe(raiderIoTierReadOffsetMs({ ...key }));
    expect(offset % dayMs).toBe(0);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThanOrEqual(14 * dayMs);
    expect(raiderIoTierReadSince(key, at).getTime()).toBe(
      at.getTime() - RAIDER_IO_TIER_READ_TTL_MS - offset
    );
  });

  it("spreads offsets across characters", () => {
    const offsets = new Set(
      [
        "alfa",
        "bravo",
        "charlie",
        "delta",
        "echo",
        "foxtrot",
        "golf",
        "hotel"
      ].map((name) =>
        raiderIoTierReadOffsetMs({ region: "eu", realm: "draenor", name })
      )
    );
    expect(offsets.size).toBeGreaterThan(1);
  });
});
