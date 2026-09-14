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

it("links a connected character to Raider.IO using its class colour", () => {
  render(
    <DossierCharacterList
      characters={[
        {
          key: { region: "eu", realm: "silvermoon", name: "ryii" },
          displayName: "Ryii",
          className: "MAGE",
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
          source: "submitted"
        }
      ]}
    />
  );

  expect(screen.getByRole("link", { name: "Ryii" })).toHaveAttribute(
    "href",
    "https://raider.io/characters/eu/silvermoon/ryii"
  );
  expect(screen.getByRole("link", { name: "Ryii" })).toHaveClass(
    "dossier-character-link--mage"
  );
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
