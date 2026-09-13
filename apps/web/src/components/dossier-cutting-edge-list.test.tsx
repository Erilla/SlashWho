// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { DossierCuttingEdgeList } from "./dossier-cutting-edge-list";

afterEach(cleanup);

it.each([
  { count: 0, label: "0 Cutting Edge achievements" },
  { count: 1, label: "1 Cutting Edge achievement" },
  { count: 2, label: "2 Cutting Edge achievements" }
])(
  "labels the count of $count achievements, regardless of linked characters",
  ({ count, label }) => {
    render(
      <DossierCuttingEdgeList
        cuttingEdges={[
          {
            achievementId: "40254",
            achievementName: "Cutting Edge: Queen Ansurek",
            description: "Defeat Queen Ansurek on Mythic Difficulty.",
            iconUrl: null,
            completedAt: "2025-01-14T20:30:00.000Z",
            characters: ["Ryii", "Ryalts", "Anotheralt"]
          },
          {
            achievementId: "19350",
            achievementName: "Cutting Edge: Fyrakk the Blazing",
            description: "Defeat Fyrakk on Mythic Difficulty.",
            iconUrl: null,
            completedAt: "2024-03-14T20:30:00.000Z",
            characters: ["Ryii"]
          }
        ].slice(0, count)}
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
  render(
    <DossierCuttingEdgeList
      cuttingEdges={[
        {
          achievementId: "40254",
          achievementName: "Cutting Edge: Queen Ansurek",
          description:
            "Defeat Queen Ansurek in Nerub-ar Palace on Mythic Difficulty.",
          iconUrl: "https://render.example/40254.jpg",
          completedAt: "2025-01-14T20:30:00.000Z",
          characters: ["Ryii", "Ryalts"]
        }
      ]}
    />
  );

  expect(
    screen.getByRole("heading", { name: "Historic Cutting Edge" })
  ).toBeVisible();
  expect(screen.getByText("Cutting Edge: Queen Ansurek")).toBeVisible();
  expect(screen.getByText("Ryii, Ryalts")).toBeVisible();
  expect(
    screen.getByAltText("Cutting Edge: Queen Ansurek icon")
  ).toHaveAttribute("src", "https://render.example/40254.jpg");
});

it("renders fallback artwork when an official achievement icon is unavailable", () => {
  render(
    <DossierCuttingEdgeList
      cuttingEdges={[
        {
          achievementId: "40254",
          achievementName: "Cutting Edge: Queen Ansurek",
          description: "Defeat Queen Ansurek on Mythic Difficulty.",
          iconUrl: null,
          completedAt: "2025-01-14T20:30:00.000Z",
          characters: ["Ryii"]
        }
      ]}
    />
  );

  expect(
    screen.getByRole("img", { name: "Cutting Edge: Queen Ansurek icon" })
  ).toBeVisible();
  expect(screen.getByText("Cutting Edge: Queen Ansurek")).toBeVisible();
});
