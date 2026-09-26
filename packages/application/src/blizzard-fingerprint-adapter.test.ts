import type { BlizzardGateway } from "@slashwho/blizzard";
import type { CharacterKey } from "@slashwho/domain";
import { describe, expect, it } from "vitest";

import { createBlizzardFingerprintAdapter } from "./blizzard-fingerprint-adapter";

function key(name: string): CharacterKey {
  return { region: "eu", realm: "silvermoon", name };
}

describe("createBlizzardFingerprintAdapter", () => {
  it("reserves concurrent reads in call order and never beyond the cap", async () => {
    // Break caught: reads in flight together each passing the cap check before
    // any of them had recorded, overspending the reservation; or a later
    // candidate taking the last request ahead of an earlier one, which leaves
    // the sweep's resume cursor either skipping or re-reading a candidate.
    const answered: string[] = [];
    let recorded = 0;
    const gateway = {
      async getAchievementFingerprint(
        target: CharacterKey,
        _signal?: AbortSignal,
        onProfileRequest?: () => Promise<void> | void
      ) {
        // Later calls reach the client first, as they can under a limiter.
        const turns = 10 - Number(target.name.slice(1));
        for (let tick = 0; tick < turns; tick += 1) await Promise.resolve();
        await onProfileRequest?.();
        answered.push(target.name);
        return new Map<number, number>();
      }
    } as unknown as BlizzardGateway;
    const adapter = createBlizzardFingerprintAdapter(gateway, {
      requestCap: 3,
      recordRequest: async () => {
        await Promise.resolve();
        recorded += 1;
      }
    });

    const results = await Promise.allSettled(
      ["c0", "c1", "c2", "c3", "c4"].map((name) =>
        adapter.getAchievementFingerprint(key(name))
      )
    );

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "rejected",
      "rejected"
    ]);
    expect(results[3]).toMatchObject({
      reason: { kind: "fingerprint_cap_reached" }
    });
    expect(recorded).toBe(3);
    expect(answered.sort()).toEqual(["c0", "c1", "c2"]);
  });

  it("charges a call's further requests against the same cap", async () => {
    // Break caught: the prepaid first request letting a multi-request call run
    // past the cap on its later requests.
    let recorded = 0;
    const gateway = {
      async getAchievementFingerprint(
        _target: CharacterKey,
        _signal?: AbortSignal,
        onProfileRequest?: () => Promise<void> | void
      ) {
        await onProfileRequest?.();
        await onProfileRequest?.();
        return new Map<number, number>();
      }
    } as unknown as BlizzardGateway;
    const adapter = createBlizzardFingerprintAdapter(gateway, {
      requestCap: 3,
      recordRequest: async () => {
        recorded += 1;
      }
    });

    await expect(adapter.getAchievementFingerprint(key("c0"))).resolves.toEqual(
      new Map()
    );
    await expect(
      adapter.getAchievementFingerprint(key("c1"))
    ).rejects.toMatchObject({ kind: "fingerprint_cap_reached" });
    expect(recorded).toBe(3);
  });
});
