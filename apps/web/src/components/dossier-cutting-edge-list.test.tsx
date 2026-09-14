// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { DossierCuttingEdgeList } from "./dossier-cutting-edge-list";

afterEach(cleanup);

it("renders an official Cutting Edge achievement with its completion date and characters", () => {
  render(
    <DossierCuttingEdgeList
      cuttingEdges={[
        {
          achievementId: "40254",
          achievementName: "Cutting Edge: Queen Ansurek",
          description:
            "Defeat Queen Ansurek in Nerub-ar Palace on Mythic Difficulty.",
          completedAt: "2025-01-14T20:30:00.000Z",
          characters: ["Ryii", "Ryalts"]
        }
      ]}
      limitations={[]}
    />
  );

  expect(
    screen.getByRole("heading", { name: "Historic Cutting Edge" })
  ).toBeVisible();
  expect(screen.getByText("Cutting Edge: Queen Ansurek")).toBeVisible();
  expect(screen.getByText("Ryii, Ryalts")).toBeVisible();
  expect(
    screen.getByRole("img", { name: "1 Cutting Edge achievement" })
  ).toHaveTextContent("1");
});

it("renders a catalogue gap between newest-first recorded achievements", () => {
  render(
    <DossierCuttingEdgeList
      cuttingEdges={[
        {
          achievementId: "41625",
          achievementName: "Cutting Edge: Dimensius, the All-Devouring",
          description: "Defeat Dimensius on Mythic Difficulty.",
          completedAt: "2025-10-14T20:30:00.000Z",
          characters: ["Ryii"]
        },
        {
          achievementId: "40254",
          achievementName: "Cutting Edge: Queen Ansurek",
          description: "Defeat Queen Ansurek on Mythic Difficulty.",
          completedAt: "2025-01-14T20:30:00.000Z",
          characters: ["Ryii"]
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
});

it("preserves completion-date ordering when it conflicts with catalogue order", () => {
  render(
    <DossierCuttingEdgeList
      cuttingEdges={[
        {
          achievementId: "41625",
          achievementName: "Cutting Edge: Dimensius, the All-Devouring",
          description: "Defeat Dimensius on Mythic Difficulty.",
          completedAt: "2025-01-14T20:30:00.000Z",
          characters: ["Ryii"]
        },
        {
          achievementId: "41297",
          achievementName: "Cutting Edge: Chrome King Gallywix",
          description: "Defeat Chrome King Gallywix on Mythic Difficulty.",
          completedAt: "2025-10-14T20:30:00.000Z",
          characters: ["Ryii"]
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
    "Cutting Edge: Chrome King Gallywix",
    "Cutting Edge: Dimensius, the All-Devouring"
  ]);
});

it("does not infer missing achievements when Blizzard evidence is limited", () => {
  render(
    <DossierCuttingEdgeList
      cuttingEdges={[
        {
          achievementId: "41625",
          achievementName: "Cutting Edge: Dimensius, the All-Devouring",
          description: "Defeat Dimensius on Mythic Difficulty.",
          completedAt: "2025-10-14T20:30:00.000Z",
          characters: ["Ryii"]
        },
        {
          achievementId: "40254",
          achievementName: "Cutting Edge: Queen Ansurek",
          description: "Defeat Queen Ansurek on Mythic Difficulty.",
          completedAt: "2025-01-14T20:30:00.000Z",
          characters: ["Ryii"]
        }
      ]}
      limitations={[
        {
          source: "blizzard",
          character: { region: "eu", realm: "silvermoon", name: "ryii" },
          code: "unavailable",
          message: "Blizzard achievement data could not be read."
        }
      ]}
    />
  );

  expect(
    screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent)
  ).toEqual([
    "Cutting Edge: Dimensius, the All-Devouring",
    "Cutting Edge: Queen Ansurek"
  ]);
  expect(screen.queryByText("Not recorded")).not.toBeInTheDocument();
});
