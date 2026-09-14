// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

it("renders each boss's consolidated evidence latest first", async () => {
  // Break caught: a dossier whose domain events were ordered latest first could
  // still render the supporting reports in the opposite order.
  render(
    <DossierRaidList
      raids={
        [
          {
            raidId: "1273",
            raidName: "Nerub-ar Palace",
            imageUrl: null,
            cuttingEdge: null,
            bosses: [
              {
                ...boss,
                imageUrl: null,
                firstKills: [
                  { ...boss.firstKill, killedAt: "2025-01-14T20:30:00.000Z" },
                  { ...boss.firstKill, killedAt: "2025-01-10T20:30:00.000Z" }
                ]
              }
            ]
          }
        ] satisfies ApplicantDossier["raids"]
      }
    />
  );

  const evidence = screen.getByRole("group", {
    name: "Queen Ansurek evidence"
  });
  await userEvent
    .setup()
    .click(within(evidence).getByText("View first-kill evidence"));

  expect(
    within(evidence)
      .getAllByText(/Jan 2025/)
      .map((element) => element.getAttribute("datetime"))
  ).toEqual(["2025-01-14T20:30:00.000Z", "2025-01-10T20:30:00.000Z"]);
});
