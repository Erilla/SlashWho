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
    spec: {
      name: "Fire",
      iconUrl:
        "https://wow.zamimg.com/images/wow/icons/medium/spell_fire_firebolt.jpg"
    },
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

it("presents every character name and metric with source links and accessible unavailable states", () => {
  // Break caught: reviewer-facing parse evidence could lose its precise fight
  // source, rely on colour alone, or imply that unavailable data is a score.
  render(<DossierParseList label="First kill parses" parses={parses} />);

  expect(screen.getByText("First kill parses")).toBeVisible();
  expect(screen.queryByText(/rankings\./)).not.toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Ryii parses" })).toBeVisible();
  expect(screen.queryByText("Paladin")).not.toBeInTheDocument();
  expect(screen.getByText("Ryii")).toBeVisible();
  const damage = screen.getByRole("link", {
    name: "Damage 87 percentile (Fire)"
  });
  expect(damage).toHaveAttribute(
    "href",
    "https://www.warcraftlogs.com/reports/damage#fight=8"
  );
  expect(damage).toHaveClass("dossier-parse-metric--purple");
  expect(screen.getByAltText("Fire specialization")).toHaveAttribute(
    "src",
    "https://wow.zamimg.com/images/wow/icons/medium/spell_fire_firebolt.jpg"
  );
  expect(screen.getAllByText("-")).toHaveLength(2);
  expect(screen.getByText("Healing")).toBeVisible();
  expect(screen.getByText("Boss Dam")).toBeVisible();
  expect(screen.queryByText("Boss Damage")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Healing" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Boss Dam" })
  ).not.toBeInTheDocument();
});

it("can omit the visible character name while retaining accessible attribution", () => {
  render(
    <DossierParseList
      label="Kill parses"
      parses={parses}
      showCharacterName={false}
    />
  );

  expect(screen.queryByText("Ryii")).not.toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Ryii parses" })).toBeVisible();
});

it("renders whole-number percentile values without the percentile suffix", () => {
  render(
    <DossierParseList
      label="Best parses"
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
    screen.getByRole("link", { name: "Damage 100 percentile (Fire)" })
  ).toHaveClass("dossier-parse-metric--gold");
  expect(screen.getByText("100", { exact: true })).toBeVisible();
});

it("rounds half-up fractional parse values in visible and accessible text", () => {
  // Break caught: a value at the half boundary could be truncated or retain a
  // decimal in either the displayed value or the link label.
  render(
    <DossierParseList
      label="Best parses"
      parses={[
        {
          ...parses[0],
          damage: {
            state: "available",
            percentile: 87.5,
            reportUrl: "https://www.warcraftlogs.com/reports/rounded#fight=9"
          }
        }
      ]}
    />
  );

  expect(
    screen.getByRole("link", { name: "Damage 88 percentile (Fire)" })
  ).toBeVisible();
  expect(screen.getByText("88", { exact: true })).toBeVisible();
});

it("shows a spinner for unavailable metrics while research is gathering", () => {
  render(
    <DossierParseList
      label="Best parses"
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
