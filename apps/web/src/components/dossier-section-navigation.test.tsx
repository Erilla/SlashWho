// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApplicantDossier } from "@slashwho/contracts";
import { afterEach, expect, it, vi } from "vitest";

import { DossierSectionNavigation } from "./dossier-section-navigation";

type Raid = ApplicantDossier["raids"][number];
type Boss = Raid["bosses"][number];

const metadata = {
  bossId: "boss",
  bossName: "Boss",
  bossOrder: 0,
  imageUrl: null
};
const kill: Extract<Boss, { state: "kill" }> = {
  ...metadata,
  state: "kill",
  firstKill: {
    killedAt: "2025-01-14T20:30:00.000Z",
    guild: null,
    historicWorldRank: null,
    reportUrl: null,
    characters: [],
    parses: []
  },
  bestParses: []
};
const wipe: Extract<Boss, { state: "wipe" }> = {
  ...metadata,
  state: "wipe",
  wipe: {
    attemptedAt: "2025-01-14T20:30:00.000Z",
    reportUrl: "https://www.warcraftlogs.com/reports/wipe",
    characters: [{ region: "eu", realm: "silvermoon", name: "Ryii" }]
  }
};
const noLogs: Boss = { ...metadata, state: "no_logs" };
const incomplete: Boss = { ...metadata, state: "incomplete" };

function raid(id: string, bosses: Boss[]): Raid {
  return {
    raidId: id,
    raidName: id,
    imageUrl: null,
    cuttingEdge: null,
    bosses
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows the strongest raid evidence and describes the colour without changing navigation names", () => {
  render(
    <DossierSectionNavigation
      hasLimitations={false}
      raids={[
        raid("logged", [
          wipe,
          noLogs,
          {
            ...kill,
            firstKill: {
              ...kill.firstKill,
              reportUrl: "https://www.warcraftlogs.com/reports/kill"
            }
          }
        ]),
        raid("later-report", [
          {
            ...kill,
            firstKills: [
              {
                ...kill.firstKill,
                reportUrl: "https://www.warcraftlogs.com/reports/later"
              }
            ]
          }
        ]),
        raid("verified", [kill, wipe]),
        raid("wipes", [wipe, noLogs]),
        raid("none", [noLogs, noLogs]),
        raid("partial-none", [noLogs, incomplete]),
        raid("incomplete", [incomplete]),
        raid("empty", [])
      ]}
    />
  );

  for (const [name, state, description] of [
    ["logged", "kill-log", "Boss kill logged"],
    ["later-report", "kill-log", "Boss kill logged"],
    ["verified", "verified-kill", "Boss kill verified"],
    ["wipes", "wipe-log", "Wipes logged"],
    ["none", "no-logs", "No logs"],
    ["partial-none", "no-logs", "No logs"],
    ["incomplete", "incomplete", "Incomplete"],
    ["empty", "incomplete", "Incomplete"]
  ]) {
    const link = screen.getByRole("link", { name: `Raid: ${name}` });
    expect(link).toHaveAttribute("data-evidence", state);
    expect(link).toHaveAttribute("aria-description", description);
    expect(
      link.querySelector(".dossier-section-navigation-label")
    ).toHaveAttribute("data-evidence-label", description);
  }
});

it("returns to the top of the page and clears the section fragment", async () => {
  const user = userEvent.setup();
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  window.history.replaceState(
    null,
    "",
    "/eu/silvermoon/ryii?tier=all#limitations-heading"
  );
  render(<DossierSectionNavigation hasLimitations raids={[]} />);

  const button = screen.getByRole("button", { name: "Back to top" });
  expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  await user.click(button);

  expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "instant" });
  expect(window.location.hash).toBe("");
  expect(window.location.pathname + window.location.search).toBe(
    "/eu/silvermoon/ryii?tier=all"
  );
  expect(
    screen.getByRole("link", { name: "Connected characters" })
  ).toHaveAttribute("aria-current", "location");
});
