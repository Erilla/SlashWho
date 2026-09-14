import { describe, expect, it } from "vitest";

import { parseColour } from "./parse-colour";

describe("parseColour", () => {
  it.each([
    [0, "grey"],
    [24.999, "grey"],
    [25, "green"],
    [49.999, "green"],
    [50, "blue"],
    [74.999, "blue"],
    [75, "purple"],
    [94.999, "purple"],
    [95, "orange"],
    [98.999, "orange"],
    [99, "pink"],
    [99.999, "pink"],
    [100, "gold"]
  ] as const)(
    "maps %s to the %s Warcraft Logs parse band",
    (percentile, colour) => {
      // Break caught: a changed interval edge could assign a parse to the wrong
      // visual band, changing the meaning reviewers infer from its presentation.
      expect(parseColour(percentile)).toBe(colour);
    }
  );

  it.each([
    -0.001,
    100.001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY
  ])(
    "rejects the invalid percentile %s rather than coercing it into a band",
    (percentile) => {
      // Break caught: malformed upstream data could be silently displayed as a
      // valid parse value instead of surfacing a contract violation.
      expect(() => parseColour(percentile)).toThrow();
    }
  );
});
