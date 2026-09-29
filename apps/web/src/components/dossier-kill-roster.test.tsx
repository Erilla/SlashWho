// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { DossierKillRoster as Roster } from "@slashwho/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { DossierKillRoster, rosterSummary } from "./dossier-kill-roster";

afterEach(cleanup);

const roster: Extract<Roster, { state: "available" }> = {
  state: "available",
  playerCount: 20,
  roleCounts: { tank: 2, healer: 4, dps: 14 },
  itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
  pulledAt: "2026-07-20T17:17:29.977Z",
  durationMs: 507_324,
  deathCount: 2,
  vantusCount: 16,
  members: [
    {
      name: "Bravo",
      realm: "twisting-nether",
      region: "eu",
      className: "Warrior",
      specName: "Protection",
      role: "tank",
      itemLevel: 292.1,
      isDossierCharacter: false
    },
    {
      name: "Charlie",
      realm: "twisting-nether",
      region: "eu",
      className: "Priest",
      specName: "Holy",
      role: "healer",
      itemLevel: 291.4,
      isDossierCharacter: false
    },
    {
      name: "Alfa",
      realm: "draenor",
      region: "eu",
      className: "Demon Hunter",
      specName: "Havoc",
      role: "dps",
      itemLevel: null,
      isDossierCharacter: true
    }
  ]
};

it("summarises the raid in one line", () => {
  expect(rosterSummary(roster)).toBe(
    "20 players · 2 tanks, 4 healers, 14 DPS · item level 290.3 (284.9–293.1) · pulled 17:17 UTC · 8:27 fight · 2 deaths · 16 Vantus runes"
  );
  expect(
    rosterSummary({
      ...roster,
      playerCount: 1,
      roleCounts: { tank: 1, healer: 0, dps: 0 },
      deathCount: 1,
      vantusCount: 1
    })
  ).toMatch(
    /^1 player · 1 tank, 0 healers, 0 DPS · .* · 1 death · 1 Vantus rune$/
  );
});

it("leaves Vantus runes out when Raider.IO gives no Vantus data, and never shows it as zero", () => {
  // #747: a null count is no answer. "0 Vantus runes" would claim the raid
  // used none.
  expect(rosterSummary({ ...roster, vantusCount: null })).toBe(
    "20 players · 2 tanks, 4 healers, 14 DPS · item level 290.3 (284.9–293.1) · pulled 17:17 UTC · 8:27 fight · 2 deaths"
  );
  expect(rosterSummary({ ...roster, vantusCount: 0 })).toMatch(
    / · 0 Vantus runes$/
  );
});

it("lists each raider with role, class colour, realm where it differs, and item level", () => {
  render(<DossierKillRoster guildRealm="Twisting Nether" roster={roster} />);

  expect(screen.getByText(rosterSummary(roster))).toBeInTheDocument();
  const rows = within(
    screen.getByRole("table", { name: "Raid roster" })
  ).getAllByRole("row");
  expect(rows).toHaveLength(4);
  const [, tank, , alfa] = rows;

  expect(within(tank!).getByRole("img", { name: "Tank" })).toBeInTheDocument();
  expect(within(tank!).queryByText("Twisting Nether")).not.toBeInTheDocument();
  expect(within(tank!).getByText("292.1")).toBeInTheDocument();
  expect(tank).not.toHaveClass("dossier-roster-row--connected");

  expect(within(alfa!).getByRole("img", { name: "DPS" })).toBeInTheDocument();
  expect(within(alfa!).getByText("Alfa")).toHaveClass(
    "dossier-character-name--demon-hunter"
  );
  expect(within(alfa!).getByText("Connected character")).toBeInTheDocument();
  expect(within(alfa!).getByText("Draenor")).toBeInTheDocument();
  // An item level Raider.IO did not give is a dash, never zero.
  expect(within(alfa!).getByText("—")).toBeInTheDocument();
  expect(alfa).toHaveClass("dossier-roster-row--connected");
});

it("shows every realm for a kill with no guild", () => {
  render(<DossierKillRoster guildRealm={null} roster={roster} />);
  expect(screen.getAllByText("Twisting Nether")).toHaveLength(2);
});

it.each([
  ["private", "The guild has hidden this raid's roster on Raider.IO."],
  ["no_logged_encounter", "Raider.IO has no logged encounter of this kill."],
  ["not_read", "Raider.IO's logged encounter has not been read yet."]
] as const)(
  "says why the roster is unavailable (%s), and never draws an empty table",
  (reason, text) => {
    render(
      <DossierKillRoster
        guildRealm={null}
        roster={{ state: "unavailable", reason }}
      />
    );
    expect(screen.getByText("Roster unavailable")).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  }
);
