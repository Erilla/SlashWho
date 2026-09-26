import { describe, expect, it } from "vitest";
import {
  parseApplicantCharacterUrl,
  parseWarcraftLogsCharacterIdUrl,
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

  // Raider.IO keeps the accents in these realms' slugs; Blizzard's slugs drop them.
  it.each([
    ["aggra-portugu%C3%AAs", "aggra-portugues"],
    ["pozzo-delleternit%C3%A0", "pozzo-delleternita"],
    ["chants-%C3%A9ternels", "chants-eternels"],
    ["Chants-%C3%89ternels", "chants-eternels"],
    ["confr%C3%A9rie-du-thorium", "confrerie-du-thorium"],
    ["mar%C3%A9cage-de-zangar", "marecage-de-zangar"]
  ])("folds the accented realm %s to %s", (realm, expected) => {
    expect(
      parseRaiderIoCharacterUrl(`https://raider.io/characters/eu/${realm}/Ryii`)
    ).toEqual({ region: "eu", realm: expected, name: "ryii" });
  });

  it("keeps the accents in a character name", () => {
    expect(
      parseRaiderIoCharacterUrl(
        "https://raider.io/characters/eu/silvermoon/R%C3%BF%C3%AFi"
      ).name
    ).toBe("rÿïi");
  });

  it.each([
    "https://example.com/characters/eu/silvermoon/ryii",
    "https://raider.io/characters/eu/%D0%B3%D0%BE%D1%80%D0%B4%D1%83%D0%BD%D0%BD%D0%B8/ryii",
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

  it("folds an accented realm in a Warcraft Logs character URL", () => {
    expect(
      parseApplicantCharacterUrl(
        "https://www.warcraftlogs.com/character/eu/aggra-portugu%C3%AAs/Ryii"
      )
    ).toEqual({ region: "eu", realm: "aggra-portugues", name: "ryii" });
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

describe("Warcraft Logs character ID URL", () => {
  it.each([
    "https://www.warcraftlogs.com/character/id/40989140",
    "https://www.warcraftlogs.com/character/ID/40989140/"
  ])("reads the stable character ID from %s", (value) => {
    expect(parseWarcraftLogsCharacterIdUrl(value)).toBe(40989140);
  });

  it.each([
    "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii",
    "https://www.warcraftlogs.com/character/id/0",
    "https://www.warcraftlogs.com/character/id/-4",
    "https://www.warcraftlogs.com/character/id/4.5",
    "https://www.warcraftlogs.com/character/id/1e6",
    "https://www.warcraftlogs.com/character/id/99999999999999999999",
    "https://www.warcraftlogs.com/character/id/40989140/extra",
    "https://www.warcraftlogs.com/character/id/40989140?zone=38",
    "https://www.warcraftlogs.com/character/id/40989140#raids",
    "http://www.warcraftlogs.com/character/id/40989140",
    "https://classic.warcraftlogs.com/character/id/40989140",
    "https://raider.io/character/id/40989140",
    "not a url"
  ])("rejects %s", (value) => {
    expect(parseWarcraftLogsCharacterIdUrl(value)).toBeUndefined();
  });

  it("is not an applicant character URL on its own", () => {
    expect(() =>
      parseApplicantCharacterUrl(
        "https://www.warcraftlogs.com/character/id/40989140"
      )
    ).toThrow("invalid_character_url");
  });
});
