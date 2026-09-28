import { expect, it } from "vitest";

import {
  dossierPath,
  raiderIoCharacterUrl,
  raiderIoGuildUrl,
  warcraftLogsCharacterUrl,
  warcraftLogsGuildUrl
} from "./dossier-path";

it("builds the canonical dossier path for a character key", () => {
  expect(
    dossierPath({ region: "eu", realm: "tarren-mill", name: "ryii" })
  ).toBe("/dossiers/eu/tarren-mill/ryii");
});

it("encodes a name outside ASCII", () => {
  expect(dossierPath({ region: "eu", realm: "silvermoon", name: "rÿii" })).toBe(
    "/dossiers/eu/silvermoon/r%C3%BFii"
  );
});

it("builds encoded upstream profile URLs from the same segments", () => {
  const key = { region: "eu", realm: "silvermoon", name: "rÿii" } as const;
  expect(warcraftLogsCharacterUrl(key)).toBe(
    "https://www.warcraftlogs.com/character/eu/silvermoon/r%C3%BFii"
  );
  expect(raiderIoCharacterUrl(key)).toBe(
    "https://raider.io/characters/eu/silvermoon/r%C3%BFii"
  );
});

it("builds encoded upstream guild URLs from the same segments", () => {
  const guild = { region: "eu", realm: "silvermoon", name: "Pure Chaos" };
  expect(raiderIoGuildUrl(guild)).toBe(
    "https://raider.io/guilds/eu/silvermoon/Pure%20Chaos"
  );
  expect(warcraftLogsGuildUrl(guild)).toBe(
    "https://www.warcraftlogs.com/guild/eu/silvermoon/Pure%20Chaos"
  );
});
