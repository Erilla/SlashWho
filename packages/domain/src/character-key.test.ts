import { describe, expect, it } from "vitest";
import {
  parseApplicantCharacterUrl,
  parseRaiderIoCharacterUrl,
  toCharacterPath,
  toRaiderIoUrl
} from "./character-key";

describe("Raider.IO character identity", () => {
  it("canonicalizes a Raider.IO character URL", () => {
    const key = parseRaiderIoCharacterUrl(
      "https://raider.io/characters/EU/Silvermoon/Ryii/"
    );

    expect(key).toEqual({ region: "eu", realm: "silvermoon", name: "ryii" });
    expect(toCharacterPath(key)).toBe("/characters/eu/silvermoon/ryii");
    expect(toRaiderIoUrl(key)).toBe(
      "https://raider.io/characters/eu/silvermoon/ryii"
    );
  });

  it.each([
    "https://example.com/characters/eu/silvermoon/ryii",
    "https://raider.io/guilds/eu/silvermoon/example",
    "https://raider.io/characters/xx/silvermoon/ryii",
    "https://user@raider.io/characters/eu/silvermoon/ryii",
    "https://raider.io/characters/eu/silvermoon/ryii?source=search"
  ])("rejects unsupported input: %s", (value) => {
    expect(() => parseRaiderIoCharacterUrl(value)).toThrow(
      "invalid_character_url"
    );
  });
});

describe("applicant character identity", () => {
  it("canonicalizes a Warcraft Logs character URL", () => {
    expect(
      parseApplicantCharacterUrl(
        "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii"
      )
    ).toEqual({ region: "eu", realm: "silvermoon", name: "ryii" });
  });

  it.each([
    "https://raider.io.evil/characters/eu/silvermoon/Ryii",
    "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii/extra",
    "https://user@www.warcraftlogs.com/character/eu/silvermoon/Ryii",
    "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii?view=profile",
    "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii#summary"
  ])("rejects unsupported applicant input: %s", (value) => {
    expect(() => parseApplicantCharacterUrl(value)).toThrow(
      "invalid_character_url"
    );
  });
});
