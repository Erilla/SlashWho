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

it("keeps achievement details when an official icon is unavailable", () => {
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

  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getByText("Cutting Edge: Queen Ansurek")).toBeVisible();
});
