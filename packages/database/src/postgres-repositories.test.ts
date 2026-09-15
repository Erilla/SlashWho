import { describe, expect, it } from "vitest";

import { isEvidenceFresh } from "./postgres-repositories";

describe("evidence freshness", () => {
  const freshnessCutoff = new Date("2026-09-14T00:00:00.000Z");

  it("does not treat a partial run as fresh after its retry time", () => {
    expect(
      isEvidenceFresh(
        new Date("2026-09-15T12:00:00.000Z"),
        new Date("2026-09-15T11:59:59.000Z"),
        freshnessCutoff
      )
    ).toBe(false);
  });

  it("keeps a partial run fresh until its retry time", () => {
    expect(
      isEvidenceFresh(
        new Date("2026-09-15T12:00:00.000Z"),
        new Date("2026-09-15T12:00:01.000Z"),
        freshnessCutoff,
        new Date("2026-09-15T11:00:00.000Z")
      )
    ).toBe(true);
  });
});
