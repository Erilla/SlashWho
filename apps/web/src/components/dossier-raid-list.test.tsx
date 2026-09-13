// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ApplicantDossier } from "@slashwho/contracts";

import { DossierRaidList } from "./dossier-raid-list";

const boss = {
  bossId: "2602",
  bossName: "Queen Ansurek",
  bossOrder: 8,
  firstKill: {
    killedAt: "2025-01-14T20:30:00.000Z",
    guild: null,
    historicWorldRank: null,
    reportUrl: null,
    characters: ["Ryii"]
  }
};

afterEach(cleanup);

it("renders official raid and boss artwork when supplied", () => {
  // Break caught: official catalogue media could reach the dossier but never
  // become visible to a guild reviewer.
  render(
    <DossierRaidList
      raids={
        [
          {
            raidId: "1273",
            raidName: "Nerub-ar Palace",
            imageUrl: "https://render.example/raids/nerub-ar.jpg",
            cuttingEdge: null,
            bosses: [
              {
                ...boss,
                imageUrl: "https://render.example/bosses/ansurek.jpg"
              }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  expect(screen.getByAltText("Nerub-ar Palace artwork")).toHaveAttribute(
    "src",
    "https://render.example/raids/nerub-ar.jpg"
  );
  expect(screen.getByAltText("Queen Ansurek artwork")).toHaveAttribute(
    "src",
    "https://render.example/bosses/ansurek.jpg"
  );
});

it("keeps text evidence intact when official artwork is unavailable", () => {
  render(
    <DossierRaidList
      raids={
        [
          {
            raidId: "unmapped",
            raidName: "Unmapped raid",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [{ ...boss, imageUrl: null }]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getByText("Queen Ansurek")).toBeVisible();
});

it("shows first-kill metadata and lists every kill in chronological order", () => {
  render(
    <DossierRaidList
      raids={
        [
          {
            raidId: "1273",
            raidName: "Nerub-ar Palace",
            imageUrl: null,
            cuttingEdge: true,
            bosses: [
              {
                ...boss,
                imageUrl: null,
                firstKills: [
                  {
                    killedAt: "2025-01-14T20:30:00.000Z",
                    guild: { name: "Method", realm: "Tarren Mill" },
                    historicWorldRank: 2,
                    reportUrl: "https://www.warcraftlogs.com/reports/first",
                    characters: ["Ryii"]
                  },
                  {
                    killedAt: "2025-02-14T20:30:00.000Z",
                    guild: { name: "Method", realm: "Tarren Mill" },
                    historicWorldRank: null,
                    reportUrl: "https://www.warcraftlogs.com/reports/second",
                    characters: ["Ryalts"]
                  }
                ]
              }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  expect(screen.getByText("First kill: 14 Jan 2025 · Ryii")).toBeVisible();
  expect(screen.getByText("View kill evidence")).toBeVisible();

  const dates = screen
    .getAllByText(/14 (Jan|Feb) 2025/)
    .filter((date) => date.tagName === "TIME");
  expect(dates.map((date) => date.textContent)).toEqual([
    "14 Jan 2025",
    "14 Feb 2025"
  ]);
});
