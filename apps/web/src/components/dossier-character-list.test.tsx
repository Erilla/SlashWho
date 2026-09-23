// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

it("offers a compact add action instead of idle character fields", () => {
  // Break caught: #148 removes the always-visible entry row, so an idle text
  // field in the panel means the dialog flow was bypassed.
  render(
    <DossierCharacterList
      characters={[]}
      root={{ region: "eu", realm: "silvermoon", name: "ryii" }}
    />
  );

  expect(screen.getByRole("button", { name: "Add character" })).toHaveClass(
    "dossier-character-add-trigger"
  );
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("opens the character dialog from the add action", async () => {
  const user = userEvent.setup();
  render(
    <DossierCharacterList
      characters={[]}
      root={{ region: "eu", realm: "silvermoon", name: "ryii" }}
    />
  );

  await user.click(screen.getByRole("button", { name: "Add character" }));

  expect(
    screen.getByRole("dialog", { name: "Add connected character" })
  ).toBeVisible();
});

it("returns focus to the add action when the dialog closes", async () => {
  // Break caught: a dialog that drops focus to the document leaves keyboard
  // viewers with no idea where they are when it closes.
  const user = userEvent.setup();
  render(
    <DossierCharacterList
      characters={[]}
      root={{ region: "eu", realm: "silvermoon", name: "ryii" }}
    />
  );

  const trigger = screen.getByRole("button", { name: "Add character" });
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("passes the already-connected characters to the dialog", async () => {
  // Break caught: without the current list the dialog cannot tell a duplicate
  // from a fresh link, because the API answers both the same way.
  const user = userEvent.setup();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(
    <DossierCharacterList
      characters={[
        {
          key: { region: "eu", realm: "silvermoon", name: "ryalts" },
          displayName: "Ryalts",
          className: null,
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryalts",
          source: "raiderio_declared"
        }
      ]}
      root={{ region: "eu", realm: "silvermoon", name: "ryii" }}
    />
  );

  await user.click(screen.getByRole("button", { name: "Add character" }));
  await user.click(screen.getByRole("textbox", { name: "Character/URL" }));
  await user.paste("https://raider.io/characters/eu/silvermoon/Ryalts");
  await user.click(
    screen.getByRole("button", { name: "Add connected character" })
  );

  expect(
    screen.getByText("Ryalts is already connected to this dossier.")
  ).toBeVisible();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("offers row actions for every connected character", () => {
  render(
    <DossierCharacterList
      characters={[
        {
          key: { region: "eu", realm: "silvermoon", name: "ryii" },
          displayName: "Ryii",
          className: "Mage",
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryii",
          source: "submitted"
        },
        {
          key: { region: "eu", realm: "silvermoon", name: "ryalts" },
          displayName: "Ryalts",
          className: "Priest",
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryalts",
          source: "fingerprint_derived"
        },
        {
          key: { region: "eu", realm: "silvermoon", name: "manual" },
          displayName: "Manual",
          className: "Warrior",
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/manual",
          source: "manually_added"
        }
      ]}
      root={{ region: "eu", realm: "silvermoon", name: "ryii" }}
    />
  );

  expect(
    screen.getByRole("button", { name: "Actions for Manual" })
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Actions for Ryalts" })
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Actions for Ryii" })
  ).toBeVisible();
});

it("hides the row actions from a read-only dossier", () => {
  // The demo dossier is frozen, so its rows must offer nothing to change.
  render(
    <DossierCharacterList
      canAddCharacters={false}
      characters={[
        {
          key: { region: "eu", realm: "silvermoon", name: "manual" },
          displayName: "Manual",
          className: "Warrior",
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/manual",
          source: "manually_added"
        }
      ]}
      root={{ region: "eu", realm: "silvermoon", name: "ryii" }}
    />
  );

  expect(
    screen.queryByRole("button", { name: "Actions for Manual" })
  ).not.toBeInTheDocument();
});

it("marks an excluded character in text rather than by dimming alone", () => {
  // Colour and opacity are not available to every reader, so the state is
  // said as well as shown.
  render(
    <DossierCharacterList
      characters={[
        {
          key: { region: "eu", realm: "silvermoon", name: "manual" },
          displayName: "Manual",
          className: "Warrior",
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/manual",
          source: "manually_added",
          excluded: true
        }
      ]}
      root={{ region: "eu", realm: "silvermoon", name: "ryii" }}
    />
  );

  expect(screen.getByText("Excluded")).toBeVisible();
  expect(screen.getByRole("listitem")).toHaveClass(
    "dossier-character-row--excluded"
  );
});

it("refreshes the dossier when a row action changes a connection", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ kind: "ready" })
  });
  vi.stubGlobal("fetch", fetchMock);
  const onCharactersChanged = vi.fn();
  render(
    <DossierCharacterList
      characters={[
        {
          key: { region: "eu", realm: "silvermoon", name: "manual" },
          displayName: "Manual",
          className: "Warrior",
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/manual",
          source: "manually_added"
        }
      ]}
      onCharactersChanged={onCharactersChanged}
      root={{ region: "eu", realm: "silvermoon", name: "ryii" }}
    />
  );

  await user.click(screen.getByRole("button", { name: "Actions for Manual" }));
  await user.click(screen.getByRole("menuitem", { name: "Exclude" }));

  await waitFor(() => expect(onCharactersChanged).toHaveBeenCalledTimes(1));
});
