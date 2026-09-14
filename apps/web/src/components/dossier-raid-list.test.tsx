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

it("shows the grouped rank in the summary and retains all distinct report links", () => {
  const reportUrls = [
    "https://www.warcraftlogs.com/reports/one#fight=1",
    "https://www.warcraftlogs.com/reports/two#fight=2"
  ];
  render(
    <DossierRaidList
      raids={[
        {
          raidId: "1320",
          raidName: "The Venomous Abyss",
          imageUrl: null,
          cuttingEdge: null,
          bosses: [
            {
              ...boss,
              bossName: "Nek'zali the Soulcoiler",
              imageUrl: null,
              firstKill: {
                ...boss.firstKill,
                historicWorldRank: 48,
                guild: { name: "Rancour", realm: "draenor" },
                reportUrl: reportUrls[0]!,
                reportUrls
              }
            }
          ]
        }
      ]}
    />
  );
  expect(screen.getByText("World #48")).toBeVisible();
  expect(
    screen
      .getAllByRole("link", { hidden: true })
      .map((link) => link.getAttribute("href"))
  ).toEqual(reportUrls);
  for (const [index, link] of screen
    .getAllByRole("link", { hidden: true })
    .entries()) {
    expect(link).toHaveAccessibleName(
      `View Warcraft Logs report ${index + 1} (opens in a new tab)`
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      link.querySelector(".upstream-link-icon--warcraft-logs")
    ).toBeInTheDocument();
  }
  expect(screen.getAllByText("First kill")).toHaveLength(1);
});

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

it("renders fallback artwork when official raid and boss artwork is unavailable", () => {
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

  expect(
    screen.getByRole("img", { name: "Unmapped raid artwork" })
  ).toBeVisible();
  expect(
    screen.getByRole("img", { name: "Queen Ansurek artwork" })
  ).toBeVisible();
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
  expect(screen.getAllByText("First kill")).toHaveLength(1);
  expect(screen.getByText("Kill")).toBeInTheDocument();
  expect(
    screen.getByRole("region", { hidden: true, name: "Kill evidence" })
  ).toBeInTheDocument();

  const dates = screen
    .getAllByText(/14 (Jan|Feb) 2025/)
    .filter((date) => date.tagName === "TIME");
  expect(dates.map((date) => date.textContent)).toEqual([
    "14 Jan 2025",
    "14 Feb 2025"
  ]);
});
