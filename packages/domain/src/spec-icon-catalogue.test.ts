import { expect, it } from "vitest";

import { specIconUrl } from "./spec-icon-catalogue";

const icon = (name: string) =>
  `https://wow.zamimg.com/images/wow/icons/medium/${name}.jpg`;

it("names the icon of a specialisation only one class has", () => {
  expect(specIconUrl("Discipline")).toBe(icon("spell_holy_powerwordshield"));
  expect(specIconUrl("Beast Mastery")).toBe(
    icon("ability_hunter_bestialdiscipline")
  );
});

it("settles a shared specialisation name by the class", () => {
  expect(specIconUrl("Frost", "DeathKnight")).toBe(
    icon("spell_deathknight_frostpresence")
  );
  expect(specIconUrl("Frost", "Mage")).toBe(icon("spell_frost_frostbolt02"));
  expect(specIconUrl("Restoration", "Death Knight")).toBeNull();
  expect(specIconUrl("Restoration", "Shaman")).toBe(
    icon("spell_nature_magicimmunity")
  );
});

it("guesses no icon for a shared name without a class", () => {
  // A guess renders a confidently wrong icon.
  for (const spec of ["Frost", "Holy", "Protection", "Restoration"]) {
    expect(specIconUrl(spec)).toBeNull();
    expect(specIconUrl(spec, null)).toBeNull();
  }
});

it("names nothing for a specialisation it does not know", () => {
  expect(specIconUrl("Chronomancy", "Evoker")).toBeNull();
});
