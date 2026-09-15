// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { DossierCharacterList } from "./dossier-character-list";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockScrollViewport(desktop: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: desktop,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
}

it("keeps submitted-character links in the dossier header and shows both profiles for alts", () => {
  render(
    <DossierCharacterList
      characters={[
        {
          key: { region: "eu", realm: "silvermoon", name: "ryii" },
          displayName: "Ryii",
          className: "MAGE",
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
          source: "submitted"
        },
        {
          key: { region: "eu", realm: "draenor", name: "ryalts" },
          displayName: "Ryalts",
          className: "Priest",
          raiderIoUrl: "https://raider.io/characters/eu/draenor/ryalts",
          source: "fingerprint_derived"
        }
      ]}
      root={{ region: "eu", realm: "silvermoon", name: "ryii" }}
    />
  );

  expect(
    screen.queryByRole("link", {
      name: "View Ryii on Raider.IO (opens in a new tab)"
    })
  ).not.toBeInTheDocument();
  const raiderIoLink = screen.getByRole("link", {
    name: "View Ryalts on Raider.IO (opens in a new tab)"
  });
  expect(raiderIoLink).toHaveAttribute(
    "href",
    "https://raider.io/characters/eu/draenor/ryalts"
  );
  expect(raiderIoLink).toHaveClass("upstream-icon-link");
  expect(
    raiderIoLink.querySelector(".upstream-link-icon--raiderio")
  ).toBeInTheDocument();

  const warcraftLogsLink = screen.getByRole("link", {
    name: "View Ryalts on Warcraft Logs (opens in a new tab)"
  });
  expect(warcraftLogsLink).toHaveAttribute(
    "href",
    "https://www.warcraftlogs.com/character/eu/draenor/ryalts"
  );
  expect(warcraftLogsLink).toHaveClass("upstream-icon-link");
  expect(
    warcraftLogsLink.querySelector(".upstream-link-icon--warcraft-logs")
  ).toBeInTheDocument();
  expect(screen.getByText("Ryii")).toHaveClass("dossier-character-name--mage");
});

it("shows a spinner only for characters whose evidence is still gathering", () => {
  render(
    <DossierCharacterList
      characters={[
        {
          key: { region: "eu", realm: "silvermoon", name: "ryii" },
          displayName: "Ryii",
          className: "Mage",
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
          source: "submitted",
          researchState: "complete"
        },
        {
          key: { region: "eu", realm: "silvermoon", name: "ryalts" },
          displayName: "Ryalts",
          className: "Priest",
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryalts",
          source: "fingerprint_derived",
          researchState: "gathering"
        }
      ]}
      root={{ region: "eu", realm: "silvermoon", name: "ryii" }}
    />
  );

  expect(
    screen.getByRole("status", { name: "Research gathering for Ryalts" })
  ).toBeVisible();
  expect(
    screen.queryByRole("status", { name: "Research gathering for Ryii" })
  ).not.toBeInTheDocument();
});

it("exposes overflowing desktop rows as a labelled keyboard-scrollable region", async () => {
  // Break caught: overflow can hide connected characters behind a scroll area
  // that keyboard and assistive-technology users cannot discover or operate.
  mockScrollViewport(true);
  render(
    <DossierCharacterList
      characters={[
        {
          key: { region: "eu", realm: "silvermoon", name: "ryii" },
          displayName: "Ryii",
          className: "Mage",
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
          source: "submitted"
        }
      ]}
      root={{ region: "eu", realm: "silvermoon", name: "ryii" }}
    />
  );

  const list = await screen.findByRole("list", {
    name: "Connected characters"
  });
  expect(list).toHaveAttribute("tabindex", "0");
  expect(list).toHaveAccessibleDescription(
    "Scroll to see more connected characters when available."
  );
});

it("does not describe naturally flowing narrow rows as scrollable", () => {
  // Break caught: responsive CSS could remove the scroll viewport while leaving
  // a misleading keyboard stop and assistive scroll instruction behind.
  mockScrollViewport(false);
  render(
    <DossierCharacterList
      characters={[
        {
          key: { region: "eu", realm: "silvermoon", name: "ryii" },
          displayName: "Ryii",
          className: "Mage",
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
          source: "submitted"
        }
      ]}
      root={{ region: "eu", realm: "silvermoon", name: "ryii" }}
    />
  );

  const list = screen.getByRole("list", { name: "Connected characters" });
  expect(list).not.toHaveAttribute("tabindex");
  expect(list).not.toHaveAccessibleDescription();
  expect(
    screen.queryByText(
      "Scroll to see more connected characters when available."
    )
  ).not.toBeInTheDocument();
});

it("shows scanning and waiting states without leaving a spinner on completed scans", () => {
  render(
    <DossierCharacterList
      characters={[
        {
          key: { region: "eu", realm: "silvermoon", name: "scanning" },
          displayName: "Scanning",
          className: null,
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/scanning",
          source: "submitted",
          evidenceState: "scanning"
        },
        {
          key: { region: "eu", realm: "silvermoon", name: "waiting" },
          displayName: "Waiting",
          className: null,
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/waiting",
          source: "raiderio_declared",
          evidenceState: "waiting"
        },
        {
          key: { region: "eu", realm: "silvermoon", name: "complete" },
          displayName: "Complete",
          className: null,
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/complete",
          source: "raiderio_declared",
          evidenceState: "complete"
        }
      ]}
      root={{ region: "eu", realm: "silvermoon", name: "scanning" }}
    />
  );

  expect(
    screen.getByRole("img", { name: "Evidence currently being scanned" })
  ).toBeVisible();
  expect(
    screen.getByRole("img", { name: "Evidence waiting to be scanned" })
  ).toBeVisible();
  expect(
    screen.queryByRole("img", { name: /scan complete/i })
  ).not.toBeInTheDocument();
});
