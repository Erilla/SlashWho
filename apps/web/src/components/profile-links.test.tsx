// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { CharacterProfileLinks, GuildProfileLinks } from "./profile-links";

afterEach(cleanup);

it("renders accessible source icons for character profiles with safe external links", () => {
  render(
    <CharacterProfileLinks
      character={{
        key: { region: "eu", realm: "silvermoon", name: "ryii" },
        displayName: "Ryii"
      }}
    />
  );

  for (const [label, href, iconClass] of [
    [
      "View Ryii on Raider.IO (opens in a new tab)",
      "https://raider.io/characters/eu/silvermoon/ryii",
      "upstream-link-icon--raiderio"
    ],
    [
      "View Ryii on Warcraft Logs (opens in a new tab)",
      "https://www.warcraftlogs.com/character/eu/silvermoon/ryii",
      "upstream-link-icon--warcraft-logs"
    ]
  ] as const) {
    const link = screen.getByRole("link", { name: label });
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link.querySelector(`.${iconClass}`)).toBeInTheDocument();
    expect(link).not.toHaveTextContent(/^(RIO|WCL)$/);
  }
});

it("uses the same source icons for guild profiles", () => {
  render(
    <GuildProfileLinks
      guild={{ name: "Guild", region: "us", realm: "area-52" }}
    />
  );

  expect(
    screen
      .getByRole("link", {
        name: "View Guild on Raider.IO (opens in a new tab)"
      })
      .querySelector(".upstream-link-icon--raiderio")
  ).toBeInTheDocument();
  expect(
    screen
      .getByRole("link", {
        name: "View Guild on Warcraft Logs (opens in a new tab)"
      })
      .querySelector(".upstream-link-icon--warcraft-logs")
  ).toBeInTheDocument();
});
