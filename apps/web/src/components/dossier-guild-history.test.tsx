// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ApplicantDossier, CharacterKey } from "@slashwho/contracts";

import { evidenceFilter } from "../lib/character-visibility";
import { DossierGuildHistory } from "./dossier-guild-history";

const ryii: CharacterKey = { region: "eu", realm: "silvermoon", name: "ryii" };
const ryun: CharacterKey = { region: "eu", realm: "silvermoon", name: "ryun" };
const rancour = { name: "Rancour", region: "eu", realm: "draenor" } as const;
const casual = {
  name: "SeriouslyCasual",
  region: "eu",
  realm: "silvermoon"
} as const;

const characters: ApplicantDossier["characters"] = [
  {
    key: ryii,
    displayName: "Ryii",
    className: "Warrior",
    raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
    guild: rancour,
    source: "submitted"
  },
  {
    key: ryun,
    displayName: "Ryun",
    className: "Priest",
    raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryun",
    guild: casual,
    source: "raiderio_declared"
  }
];

function nights(dates: readonly string[], who: readonly CharacterKey[]) {
  return dates.map((date) => ({ date, characters: [...who] }));
}

const guildHistory: NonNullable<ApplicantDossier["guildHistory"]> = [
  {
    guild: casual,
    nights: nights(["2023-03-08", "2023-06-14", "2023-12-10"], [ryun])
  },
  {
    guild: { ...rancour, name: "Pure Chaos" },
    nights: nights(["2024-03-15"], [ryii])
  },
  {
    guild: rancour,
    nights: nights(["2025-01-26", "2025-05-04", "2025-09-11"], [ryii])
  }
];

afterEach(cleanup);

it("sits in its own section, named for the section navigation", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  expect(
    screen.getByRole("heading", { name: "Guild history" })
  ).toHaveAttribute("id", "guild-history-heading");
});

it("draws a bar per guild seen on more than one raid night", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const bars = screen.getAllByRole("img", { name: /raid night/ });
  expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual([
    expect.stringMatching(
      /^SeriouslyCasual\. 8 Mar 2023 to 10 Dec 2023\. 3 raid nights: Ryun/
    ),
    expect.stringMatching(
      /^Rancour\. 26 Jan 2025 to 11 Sept? 2025\. 3 raid nights: Ryii/
    )
  ]);
  expect(screen.queryByText("Pure Chaos")).not.toBeInTheDocument();
});

it("shows the details in a tooltip on hover and on focus", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const [casualBar] = screen.getAllByRole("img", { name: /raid night/ });
  fireEvent.mouseEnter(casualBar!);
  expect(screen.getByText("3 raid nights: Ryun")).toBeInTheDocument();
  fireEvent.mouseLeave(casualBar!.closest("svg")!);
  expect(screen.queryByText("3 raid nights: Ryun")).not.toBeInTheDocument();
  fireEvent.focus(casualBar!);
  expect(screen.getByText("3 raid nights: Ryun")).toBeInTheDocument();
});

it("scrolls horizontally in a keyboard-reachable region", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  expect(
    screen.getByRole("region", {
      name: "Guild history timeline, scrolls horizontally"
    })
  ).toHaveAttribute("tabindex", "0");
});

it("marks the guilds the latest snapshot holds", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const rancourToday = screen.getByRole("img", {
    name: "Rancour today. 1 character in the latest snapshot"
  });
  const casualToday = screen.getByRole("img", {
    name: "SeriouslyCasual today. 1 character in the latest snapshot"
  });
  // Both histories end in the top row; the markers must not coincide.
  expect(casualToday.querySelector("circle")?.getAttribute("cx")).not.toBe(
    rancourToday.querySelector("circle")?.getAttribute("cx")
  );
});

it("keeps a guild's colour when a character is hidden", () => {
  const colourOf = (name: string) =>
    screen
      .getAllByRole("img", { name: new RegExp(`^${name}\\. .*raid night`) })[0]
      ?.querySelector("rect")
      ?.getAttribute("fill");
  const { rerender } = render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const before = colourOf("Rancour");
  rerender(
    <DossierGuildHistory
      characters={characters}
      filter={evidenceFilter(characters, new Set(["eu/silvermoon/ryun"]))}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  expect(colourOf("Rancour")).toBe(before);
});

it("leaves out hidden characters' nights", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      filter={evidenceFilter(characters, new Set(["eu/silvermoon/ryun"]))}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  expect(
    screen
      .getAllByRole("img", { name: /raid night/ })
      .map((bar) => bar.getAttribute("aria-label")?.split(".")[0])
  ).toEqual(["Rancour"]);
  expect(
    screen.queryByRole("img", { name: /^SeriouslyCasual today/ })
  ).not.toBeInTheDocument();
});

it("says so when no guild has more than one raid night", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={[guildHistory[1]!]}
      today="2026-09-26"
    />
  );
  expect(
    screen.getByText(
      "No guild has more than one raid night in the stored evidence."
    )
  ).toBeInTheDocument();
});
