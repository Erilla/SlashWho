// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { DossierCuttingEdgeList } from "./dossier-cutting-edge-list";

it("renders an official account-wide Cutting Edge achievement without character attribution", () => {
  render(
    <DossierCuttingEdgeList
      cuttingEdges={[
        {
          achievementId: "40254",
          achievementName: "Cutting Edge: Queen Ansurek",
          description:
            "Defeat Queen Ansurek in Nerub-ar Palace on Mythic Difficulty.",
          completedAt: "2025-01-14T20:30:00.000Z"
        }
      ]}
    />
  );

  expect(
    screen.getByRole("heading", { name: "Historic Cutting Edge" })
  ).toBeVisible();
  expect(screen.getByText("Cutting Edge: Queen Ansurek")).toBeVisible();
  expect(screen.queryByText("Ryii, Ryalts")).not.toBeInTheDocument();
});
