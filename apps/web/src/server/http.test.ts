import { describe, expect, it } from "vitest";

import { parseCharacterRoute } from "./http";

describe("character route parsing", () => {
  it("accepts a percent-encoded Unicode name from the page route", () => {
    expect(
      parseCharacterRoute({
        region: "eu",
        realm: "silvermoon",
        name: "eldr%C3%ADtch"
      })
    ).toEqual({
      key: { region: "eu", realm: "silvermoon", name: "eldrítch" },
      canonical: true
    });
  });
});
