// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import type { CharacterKey, DossierCharacter } from "@slashwho/contracts";

import {
  DossierCharacterName,
  DossierCharacterNames,
  DossierCharacterProvider
} from "./dossier-character-name";

const classes = [
  ["Death Knight", "death-knight"],
  ["Demon Hunter", "demon-hunter"],
  ["Druid", "druid"],
  ["Evoker", "evoker"],
  ["Hunter", "hunter"],
  ["Mage", "mage"],
  ["Monk", "monk"],
  ["Paladin", "paladin"],
  ["Priest", "priest"],
  ["Rogue", "rogue"],
  ["Shaman", "shaman"],
  ["Warlock", "warlock"],
  ["Warrior", "warrior"]
] as const;

const mage: DossierCharacter = {
  key: { region: "eu", realm: "silvermoon", name: "ryii" },
  displayName: "Ryii",
  className: "Mage",
  raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
  source: "submitted"
};

const sameNamedPriest: DossierCharacter = {
  ...mage,
  key: { region: "us", realm: "stormrage", name: "ryii" },
  className: "Priest",
  raiderIoUrl: "https://raider.io/characters/us/stormrage/ryii"
};

afterEach(cleanup);

function dossierCharacter(
  className: DossierCharacter["className"],
  name = "Ryii"
): DossierCharacter {
  return {
    ...mage,
    key: { ...mage.key, name: name.toLowerCase() },
    displayName: name,
    className
  };
}

it.each(classes)(
  "renders %s with the shared %s modifier",
  (className, modifier) => {
    const character = dossierCharacter(className);

    render(<DossierCharacterName character={character} />);

    expect(screen.getByText("Ryii")).toHaveClass(
      `dossier-character-name--${modifier}`
    );
  }
);

it("resolves same-named characters by their complete canonical key", () => {
  render(
    <DossierCharacterProvider characters={[mage, sameNamedPriest]}>
      <DossierCharacterName character={sameNamedPriest.key} />
    </DossierCharacterProvider>
  );

  expect(screen.getByText("Ryii")).toHaveClass(
    "dossier-character-name--priest"
  );
});

it.each([null, "Unknown class"])(
  "uses a neutral name for a %s class",
  (className) => {
    render(<DossierCharacterName character={dossierCharacter(className)} />);

    const name = screen.getByText("Ryii");
    expect(name).toHaveClass("dossier-character-name");
    expect(name.className).toBe("dossier-character-name");
  }
);

it("uses a neutral visible fallback for an unresolved key", () => {
  const unresolved: CharacterKey = {
    region: "eu",
    realm: "argent-dawn",
    name: "missing"
  };

  render(
    <DossierCharacterProvider characters={[mage]}>
      <DossierCharacterName character={unresolved} />
    </DossierCharacterProvider>
  );

  const name = screen.getByText("missing");
  expect(name).toHaveClass("dossier-character-name");
  expect(name.className).toBe("dossier-character-name");
});

it("renders keyed character lists as individually styled names", () => {
  render(
    <DossierCharacterProvider characters={[mage, sameNamedPriest]}>
      <DossierCharacterNames characters={[mage.key, sameNamedPriest.key]} />
    </DossierCharacterProvider>
  );

  const names = screen.getAllByText("Ryii");
  expect(names[0]).toHaveClass("dossier-character-name--mage");
  expect(names[1]).toHaveClass("dossier-character-name--priest");
});
