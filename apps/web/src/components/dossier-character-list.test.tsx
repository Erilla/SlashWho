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
    screen.queryByRole("link", { name: "View Ryii on Raider.IO" })
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "View Ryalts on Raider.IO" })
  ).toHaveAttribute("href", "https://raider.io/characters/eu/draenor/ryalts");
  expect(
    screen.getByRole("link", { name: "View Ryalts on Warcraft Logs" })
  ).toHaveAttribute(
    "href",
    "https://www.warcraftlogs.com/character/eu/draenor/ryalts"
  );
  expect(screen.getByText("Ryii")).toHaveClass("dossier-character-name--mage");
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
