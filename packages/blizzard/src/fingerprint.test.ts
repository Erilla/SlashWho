import { describe, expect, it } from "vitest";

import { compareFingerprints } from "./fingerprint";

function fingerprint(
  common: number,
  identical: number
): ReadonlyMap<number, number> {
  return new Map(
    Array.from({ length: common }, (_, id) => [id, id < identical ? id : -id])
  );
}

describe("compareFingerprints", () => {
  it("requires both the common-achievement floor and identical-timestamp floor", () => {
    // Break caught: accepting a candidate when either threshold is not met.
    const root = new Map(Array.from({ length: 200 }, (_, id) => [id, id]));
    const tooSmall = fingerprint(199, 199);
    const belowPercent = fingerprint(200, 39);
    const exactBoundary = fingerprint(200, 40);
    const policy = { minimumCommon: 200, minimumIdenticalPercent: 20 };

    expect(compareFingerprints(root, tooSmall, policy).isMatch).toBe(false);
    expect(compareFingerprints(root, belowPercent, policy).isMatch).toBe(false);
    expect(compareFingerprints(root, exactBoundary, policy)).toMatchObject({
      common: 200,
      identical: 40,
      isMatch: true
    });
  });
});
