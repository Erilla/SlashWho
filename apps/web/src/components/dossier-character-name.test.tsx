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

it("shows comma-separated historic identities on hover and keyboard focus", () => {
  render(
    <DossierCharacterName
      character={{
        ...mage,
        historicAliases: [
          { region: "eu", realm: "neptulon", name: "erilla" },
          { region: "eu", realm: "draenor", name: "former" }
        ]
      }}
      showGuild
    />
  );
  const name = screen.getByText("Ryii");
  const tooltip = screen.getByRole("tooltip");
  expect(name).toHaveAttribute("tabindex", "0");
  expect(name).toHaveAttribute("aria-describedby", tooltip.id);
  expect(tooltip).toHaveTextContent(
    "Also known as: Erilla-Neptulon, Former-Draenor"
  );
});

it("names Warcraft Logs-verified aliases alongside declared ones, once each", () => {
  render(
    <DossierCharacterName
      character={{
        ...mage,
        historicAliases: [{ region: "eu", realm: "neptulon", name: "erilla" }],
        warcraftLogsAliases: [
          { region: "eu", realm: "Neptulon", name: "Erilla" },
          { region: "eu", realm: "silvermoon", name: "ryun" }
        ]
      }}
      showGuild
    />
  );
  expect(screen.getByRole("tooltip")).toHaveTextContent(
    "Also known as: Erilla-Neptulon, Ryun-Silvermoon"
  );
});

it("does not create an alias tooltip when no aliases exist", () => {
  render(<DossierCharacterName character={mage} showGuild />);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(screen.getByText("Ryii")).not.toHaveAttribute("tabindex");
});

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

  const name = screen.getByText("Missing");
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

const guilded: DossierCharacter = {
  ...mage,
  guild: { name: "Rancour", region: "eu", realm: "draenor" }
};

it("shows a character's guild only where the caller asks for it", () => {
  render(<DossierCharacterName character={guilded} showGuild />);

  expect(screen.getByText("<Rancour>")).toBeInTheDocument();
});

it("omits the guild by default, so inline names stay unchanged", () => {
  // The same component renders names inside parse, kill and wipe rows, where a
  // guild on every mention would bury the evidence it sits next to.
  render(<DossierCharacterName character={guilded} />);

  expect(screen.queryByText("<Rancour>")).not.toBeInTheDocument();
});

it("renders nothing extra for a guildless character", () => {
  render(<DossierCharacterName character={mage} showGuild />);

  expect(screen.getByText("Ryii")).toBeInTheDocument();
  expect(screen.queryByText(/</)).not.toBeInTheDocument();
});
