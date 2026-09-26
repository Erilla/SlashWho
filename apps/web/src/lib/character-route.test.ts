import { expect, it } from "vitest";

import { parseCharacterRoute } from "./character-route";

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

it("reports a spelling other than the canonical key", () => {
  expect(
    parseCharacterRoute({ region: "EU", realm: "Silvermoon", name: "Ryii" })
  ).toEqual({
    key: { region: "eu", realm: "silvermoon", name: "ryii" },
    canonical: false
  });
});

it("refuses a segment that is not valid percent-encoding", () => {
  expect(() =>
    parseCharacterRoute({ region: "eu", realm: "silvermoon", name: "%E0%A4%A" })
  ).toThrow("invalid_character_url");
});
