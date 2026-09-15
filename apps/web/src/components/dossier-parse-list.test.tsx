// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ApplicantDossier } from "@slashwho/contracts";

import { DossierParseList } from "./dossier-parse-list";

type KillBoss = Extract<
  ApplicantDossier["raids"][number]["bosses"][number],
  { state: "kill" }
>;
type ApplicantDossierCharacterParses = KillBoss["bestParses"][number];

const parses = [
  {
    character: "Ryii",
    classSpec: "Fire",
    damage: {
      state: "available",
      percentile: 87.19,
      reportUrl: "https://www.warcraftlogs.com/reports/damage#fight=8"
    },
    healing: { state: "not_applicable" },
    bossDamage: { state: "unavailable" }
  }
] satisfies ApplicantDossierCharacterParses[];

afterEach(cleanup);

it("presents every character metric with source links and accessible unavailable states", () => {
  // Break caught: reviewer-facing parse evidence could lose its precise fight
  // source, rely on colour alone, or imply that unavailable data is a score.
  render(<DossierParseList label="First kill parses" parses={parses} />);

  expect(screen.getByText("First kill parses")).toBeVisible();
  expect(screen.queryByText(/rankings\./)).not.toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Ryii parses" })).toBeVisible();
  expect(screen.getByText("Fire")).toBeVisible();
  expect(screen.queryByText("Ryii")).not.toBeInTheDocument();
  const damage = screen.getByRole("link", {
    name: "Damage 87.1 percentile"
  });
  expect(damage).toHaveAttribute(
    "href",
    "https://www.warcraftlogs.com/reports/damage#fight=8"
  );
  expect(damage).toHaveClass("dossier-parse-metric--purple");
  expect(screen.getAllByText("-")).toHaveLength(2);
  expect(screen.getByText("Healing")).toBeVisible();
  expect(screen.getByText("Boss Damage")).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "Healing" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Boss Damage" })
  ).not.toBeInTheDocument();
});

it("uses ordinal percentile labels for whole-number parse values", () => {
  // Break caught: whole values could be rendered as ambiguous raw numbers,
  // leaving assistive-technology users without a percentile explanation.
  render(
    <DossierParseList
      label="Best shown parses"
      parses={[
        {
          ...parses[0],
          damage: {
            state: "available",
            percentile: 100,
            reportUrl: "https://www.warcraftlogs.com/reports/gold#fight=9"
          }
        }
      ]}
    />
  );

  expect(
    screen.getByRole("link", { name: "Damage 100th percentile" })
  ).toHaveClass("dossier-parse-metric--gold");
});

it("shows a spinner for unavailable metrics while research is gathering", () => {
  render(
    <DossierParseList
      label="Best shown parses"
      loading
      parses={[
        {
          ...parses[0],
          damage: { state: "unavailable" },
          healing: { state: "not_applicable" },
          bossDamage: { state: "unavailable" }
        }
      ]}
    />
  );

  expect(screen.getAllByRole("status", { name: "Loading parse" })).toHaveLength(
    2
  );
  expect(screen.getAllByText("-")).toHaveLength(1);
});
