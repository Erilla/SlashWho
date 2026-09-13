// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { DossierCharacterList } from "./dossier-character-list";

it("links a connected character to Raider.IO using its class colour", () => {
  render(
    <DossierCharacterList
      characters={[
        {
          key: { region: "eu", realm: "silvermoon", name: "ryii" },
          displayName: "Ryii",
          className: "MAGE",
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
          source: "submitted"
        }
      ]}
    />
  );

  expect(screen.getByRole("link", { name: "Ryii" })).toHaveAttribute(
    "href",
    "https://raider.io/characters/eu/silvermoon/ryii"
  );
  expect(screen.getByRole("link", { name: "Ryii" })).toHaveClass(
    "dossier-character-link--mage"
  );
});
