import { expect, it } from "vitest";

import { isRosterShown } from "./logged-encounter";

it.each([
  ["a visible roster", true, [{}], true],
  ["a roster whose privacy Raider.IO did not state", undefined, [{}], true],
  ["a guild with no privacy block (a pug)", null, [{}], true],
  ["a hidden composition", false, [{}], false],
  ["an empty roster", true, [], false]
] as const)("shows %s: %s", (_name, raidComps, members, shown) => {
  // An empty roster reads as "nobody was there", which Raider.IO never means.
  expect(isRosterShown(raidComps, members)).toBe(shown);
});
