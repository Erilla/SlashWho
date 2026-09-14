// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { CharacterKey } from "@slashwho/contracts";
import type { ReactElement } from "react";

import { DossierCharacterProvider } from "./dossier-character-name";
import { DossierCuttingEdgeList } from "./dossier-cutting-edge-list";

const ryii: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "ryii"
};
const ryalts: CharacterKey = {
  region: "eu",
  realm: "draenor",
  name: "ryalts"
};
const anotheralt: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "anotheralt"
};
const knownCharacters = [
  {
    key: ryii,
    displayName: "Ryii",
    className: "Mage",
    raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
    source: "submitted" as const
  },
  {
    key: ryalts,
    displayName: "Ryalts",
    className: "Priest",
    raiderIoUrl: "https://raider.io/characters/eu/draenor/ryalts",
    source: "fingerprint_derived" as const
  },
  {
    key: anotheralt,
    displayName: "Anotheralt",
    className: "Warrior",
    raiderIoUrl: "https://raider.io/characters/eu/silvermoon/anotheralt",
    source: "fingerprint_derived" as const
  }
];

function renderWithDossierCharacters(ui: ReactElement) {
  return render(
    <DossierCharacterProvider characters={knownCharacters}>
      {ui}
    </DossierCharacterProvider>
  );
}

afterEach(cleanup);

it.each([
  { count: 0, label: "0 Cutting Edge achievements" },
  { count: 1, label: "1 Cutting Edge achievement" },
  { count: 2, label: "2 Cutting Edge achievements" }
])(
  "labels the count of $count achievements, regardless of linked characters",
  ({ count, label }) => {
    renderWithDossierCharacters(
      <DossierCuttingEdgeList
        cuttingEdges={[
          {
            achievementId: "40254",
            achievementName: "Cutting Edge: Queen Ansurek",
            description: "Defeat Queen Ansurek on Mythic Difficulty.",
            iconUrl: null,
            completedAt: "2025-01-14T20:30:00.000Z",
            characters: [ryii, ryalts, anotheralt]
          },
          {
            achievementId: "19350",
            achievementName: "Cutting Edge: Fyrakk the Blazing",
            description: "Defeat Fyrakk on Mythic Difficulty.",
            iconUrl: null,
            completedAt: "2024-03-14T20:30:00.000Z",
            characters: [ryii]
          }
        ].slice(0, count)}
        limitations={[]}
      />
    );

    expect(screen.getByRole("img", { name: label })).toHaveTextContent(
      String(count)
    );
    expect(
      screen.getByRole("heading", { name: "Historic Cutting Edge" })
    ).toBeVisible();
    if (count === 0) {
      expect(
        screen.getByText("No public Cutting Edge achievements were found.")
      ).toBeVisible();
    }
  }
);

it("renders an official Cutting Edge achievement with its completion date and characters", () => {
  renderWithDossierCharacters(
    <DossierCuttingEdgeList
      cuttingEdges={[
        {
          achievementId: "40254",
          achievementName: "Cutting Edge: Queen Ansurek",
          description:
            "Defeat Queen Ansurek in Nerub-ar Palace on Mythic Difficulty.",
          iconUrl: "https://render.example/40254.jpg",
          completedAt: "2025-01-14T20:30:00.000Z",
          characters: [ryii, ryalts]
        }
      ]}
      limitations={[]}
    />
  );

  expect(
    screen.getByRole("heading", { name: "Historic Cutting Edge" })
  ).toBeVisible();
  expect(screen.getByText("Cutting Edge: Queen Ansurek")).toBeVisible();
  expect(screen.getByText("Ryii").parentElement).toHaveTextContent(
    "Ryii, Ryalts"
  );
  expect(
    screen.getByAltText("Cutting Edge: Queen Ansurek icon")
  ).toHaveAttribute("src", "https://render.example/40254.jpg");
});

it("renders fallback artwork when an official achievement icon is unavailable", () => {
  renderWithDossierCharacters(
    <DossierCuttingEdgeList
      cuttingEdges={[
        {
          achievementId: "40254",
          achievementName: "Cutting Edge: Queen Ansurek",
          description: "Defeat Queen Ansurek on Mythic Difficulty.",
          iconUrl: null,
          completedAt: "2025-01-14T20:30:00.000Z",
          characters: [ryii]
        }
      ]}
      limitations={[]}
    />
  );

  expect(
    screen.getByRole("img", { name: "Cutting Edge: Queen Ansurek icon" })
  ).toBeVisible();
  expect(screen.getByText("Cutting Edge: Queen Ansurek")).toBeVisible();
});

it("renders catalogue-ordered gaps as not recorded between earned achievements", () => {
  renderWithDossierCharacters(
    <DossierCuttingEdgeList
      cuttingEdges={[
        {
          achievementId: "40254",
          achievementName: "Cutting Edge: Queen Ansurek",
          description: "Defeat Queen Ansurek on Mythic Difficulty.",
          iconUrl: null,
          completedAt: "2025-01-14T20:30:00.000Z",
          characters: [ryii]
        },
        {
          achievementId: "41625",
          achievementName: "Cutting Edge: Dimensius, the All-Devouring",
          description: "Defeat Dimensius on Mythic Difficulty.",
          iconUrl: null,
          completedAt: "2025-10-14T20:30:00.000Z",
          characters: [ryii]
        }
      ]}
      limitations={[]}
    />
  );

  expect(
    screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent)
  ).toEqual([
    "Cutting Edge: Dimensius, the All-Devouring",
    "Cutting Edge: Chrome King Gallywix",
    "Cutting Edge: Queen Ansurek"
  ]);
  expect(screen.getByText("Not recorded")).toBeVisible();
  expect(
    screen.getByRole("img", { name: "2 Cutting Edge achievements" })
  ).toHaveTextContent("2");
});

it("does not infer a missing achievement when Blizzard evidence is limited", () => {
  renderWithDossierCharacters(
    <DossierCuttingEdgeList
      cuttingEdges={[
        {
          achievementId: "40254",
          achievementName: "Cutting Edge: Queen Ansurek",
          description: "Defeat Queen Ansurek on Mythic Difficulty.",
          iconUrl: null,
          completedAt: "2025-01-14T20:30:00.000Z",
          characters: [ryii]
        },
        {
          achievementId: "41625",
          achievementName: "Cutting Edge: Dimensius, the All-Devouring",
          description: "Defeat Dimensius on Mythic Difficulty.",
          iconUrl: null,
          completedAt: "2025-10-14T20:30:00.000Z",
          characters: [ryii]
        }
      ]}
      limitations={[
        {
          source: "blizzard",
          character: { region: "eu", realm: "silvermoon", name: "ryalts" },
          code: "unavailable",
          message: "Blizzard achievement data could not be read."
        }
      ]}
    />
  );

  expect(
    screen.queryByText("Cutting Edge: Chrome King Gallywix")
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Not recorded")).not.toBeInTheDocument();
});
