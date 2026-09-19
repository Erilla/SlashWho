import { expect, it } from "vitest";

import dungeonCatalogue from "./dungeon-catalogue.generated.json";
import { isKnownDungeonZone } from "./dungeon-catalogue";
import raidCatalogue from "./raid-catalogue.generated.json";

it("recognizes the Mythic dungeons a veteran's history is full of", () => {
  // Every one of these was live on eu/silvermoon/ryii's stored kills, filed as
  // raid evidence because a Mythic dungeon boss and a Mythic raid boss share a
  // difficulty (#346).
  for (const zoneName of [
    "Mists of Tirna Scithe",
    "The Necrotic Wake",
    "Vault of the Wardens",
    "Darkflame Cleft",
    "The Rookery",
    "Cinderbrew Meadery",
    "Operation: Mechagon",
    "Tazavesh, the Veiled Market"
  ]) {
    expect(isKnownDungeonZone(zoneName)).toBe(true);
  }
});

it("recognizes a dungeon however Warcraft Logs punctuates it", () => {
  expect(isKnownDungeonZone("tazavesh the veiled market")).toBe(true);
  expect(isKnownDungeonZone("  Operation:  Mechagon  ")).toBe(true);
});

it("never claims a raid is a dungeon", () => {
  for (const raid of raidCatalogue.raids) {
    expect(isKnownDungeonZone(raid.raidName)).toBe(false);
  }
});

it("leaves a zone in neither catalogue unplaceable", () => {
  // The conservative half of the gate: a raid-shaped zone nobody can place is
  // evidence going missing, and must keep saying so rather than being quietly
  // filed as a dungeon.
  expect(isKnownDungeonZone("A Raid Nobody Has Catalogued")).toBe(false);
});

it("names no dungeon that is also a catalogued raid", () => {
  // A collision would let this gate discard real raid evidence, so it fails
  // the build rather than being resolved at lookup time.
  const raidNames = new Set(raidCatalogue.raids.map((raid) => raid.raidName));
  expect(
    dungeonCatalogue.dungeons
      .map((dungeon) => dungeon.dungeonName)
      .filter((dungeonName) => raidNames.has(dungeonName))
  ).toEqual([]);
});
