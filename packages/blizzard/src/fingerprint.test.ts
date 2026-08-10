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

  it("does not allow caller policy to lower the mandatory match floors", () => {
    // Break caught: worker configuration could turn a weak coincidence into a
    // fingerprint-derived relationship by supplying lower thresholds.
    const weakPolicy = { minimumCommon: 1, minimumIdenticalPercent: 0 };
    const fewerThanMandatoryCommon = fingerprint(199, 199);
    const belowMandatoryIdenticalPercent = fingerprint(200, 0);

    expect(
      compareFingerprints(
        fewerThanMandatoryCommon,
        fewerThanMandatoryCommon,
        weakPolicy
      ).isMatch
    ).toBe(false);
    expect(
      compareFingerprints(
        fingerprint(200, 200),
        belowMandatoryIdenticalPercent,
        weakPolicy
      ).isMatch
    ).toBe(false);
  });
});
