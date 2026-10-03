// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { dossierRaidSchema } from "@slashwho/contracts";
import { buildApplicantDossier } from "@slashwho/domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { DossierCharacterProvider } from "./dossier-character-name";
import { DossierRaidList } from "./dossier-raid-list";

afterEach(cleanup);

it("renders an upstream-proven historic kill without WCL logs while preserving its historic roster identity", () => {
  const key = { region: "eu", realm: "silvermoon", name: "sentinel" } as const;
  const characters = [
    {
      key,
      displayName: "Sentinel",
      className: "Mage",
      source: "submitted" as const,
      raiderIoUrl: "https://raider.io/characters/eu/silvermoon/sentinel"
    }
  ];
  // This is the public projection after the collector has proved presence.
  // The resolver's current ID must not rewrite or highlight the old member.
  const dossier = buildApplicantDossier({
    root: key,
    characters,
    kills: [],
    limitations: [],
    raiderIoFirstKills: [
      {
        character: key,
        raidSlug: "sepulcher-of-the-first-ones",
        bossSlug: "the-jailer",
        killedAt: "2022-05-20T20:10:00.000Z",
        guild: null,
        historicWorldRank: null,
        encounter: {
          state: "read",
          encounter: {
            pulledAt: "2022-05-20T20:00:00.000Z",
            defeatedAt: "2022-05-20T20:10:00.000Z",
            durationMs: 600000,
            guild: null,
            itemLevel: { average: 275, min: 270, max: 280 },
            deathCount: 0,
            vantusCount: null,
            roster: {
              state: "available",
              roleCounts: { tank: 0, healer: 0, dps: 1 },
              members: [
                {
                  name: "Sentinel-123",
                  realm: "argent-dawn",
                  region: "eu",
                  className: "Mage",
                  specName: "Fire",
                  role: "dps",
                  itemLevel: 275
                }
              ]
            }
          }
        }
      }
    ]
  });
  render(
    <DossierCharacterProvider characters={characters}>
      <DossierRaidList
        raids={dossier.raids.map((raid) => dossierRaidSchema.parse(raid))}
      />
    </DossierCharacterProvider>
  );
  expect(screen.getByText("The Jailer")).toBeVisible();
  expect(screen.getAllByText("No public logs found").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByText("View kill evidence"));
  const evidence = screen.getByRole("region", { name: "Kill evidence" });
  expect(
    within(evidence).getByText("No public logs found", { selector: "li" })
  ).toBeVisible();
  fireEvent.click(within(evidence).getByText("View roster"));
  const table = within(evidence).getByRole("table", { name: "Raid roster" });
  const row = within(table).getByText("Sentinel-123").closest("tr");
  expect(row).not.toHaveClass("dossier-roster-row--connected");
  expect(within(row!).getByText("Argent Dawn")).toBeVisible();
  expect(
    within(table).queryByText("Connected character")
  ).not.toBeInTheDocument();
  expect(
    within(table).queryByText("Sentinel", { exact: true })
  ).not.toBeInTheDocument();
  expect(
    within(evidence).queryByRole("link", { name: /report/i })
  ).not.toBeInTheDocument();
});
