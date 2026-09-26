// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ApplicantDossier, CharacterKey } from "@slashwho/contracts";

import { evidenceFilter } from "../lib/character-visibility";
import { DossierCharacterProvider } from "./dossier-character-name";
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
  const nightsLine = () =>
    document.querySelector(".dossier-guild-timeline-tooltip span")?.textContent;
  fireEvent.mouseEnter(casualBar!);
  expect(nightsLine()).toBe("8 Mar 2023 to 10 Dec 2023");
  expect(
    document.querySelector(".dossier-guild-timeline-tooltip")?.textContent
  ).toContain("3 raid nights: Ryun");
  fireEvent.mouseLeave(casualBar!.closest("svg")!);
  expect(
    document.querySelector(".dossier-guild-timeline-tooltip")
  ).not.toBeInTheDocument();
  fireEvent.focus(casualBar!);
  expect(
    document.querySelector(".dossier-guild-timeline-tooltip")?.textContent
  ).toContain("3 raid nights: Ryun");
});

/** Gives the scroller a view width and a scroll offset jsdom does not have. */
function withScroller(clientWidth: number, run: () => void) {
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth"
  );
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return clientWidth;
    }
  });
  try {
    run();
  } finally {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", original);
    }
  }
}

function scrollTo(region: HTMLElement, offset: number) {
  Object.defineProperty(region, "scrollLeft", {
    configurable: true,
    get: () => offset,
    set: () => {}
  });
  fireEvent.scroll(region);
}

it("keeps a focused bar's tooltip when focus scrolls the bar into view", () => {
  withScroller(375, () => {
    render(
      <DossierGuildHistory
        characters={characters}
        guildHistory={guildHistory}
        today="2026-09-26"
      />
    );
    const region = screen.getByRole("region", {
      name: "Guild history timeline, scrolls horizontally"
    });
    // Opened at the present, so the oldest bar is out of view to the left.
    Object.defineProperty(region, "scrollLeft", {
      configurable: true,
      get: () => 500,
      set: () => {}
    });
    const [casualBar] = screen.getAllByRole("img", { name: /raid night/ });
    const barX = Number(casualBar!.querySelector("rect")!.getAttribute("x"));
    act(() => casualBar!.focus());
    // Focusing it makes the browser scroll it into view, after `focus`.
    scrollTo(region, barX - 20);
    const tooltip = document.querySelector<HTMLElement>(
      ".dossier-guild-timeline-tooltip"
    );
    expect(tooltip?.textContent).toContain("3 raid nights: Ryun");
    expect(tooltip?.style.left).toBe("20px");
  });
});

it("hides a hovered bar's tooltip when the timeline scrolls", () => {
  withScroller(375, () => {
    render(
      <DossierGuildHistory
        characters={characters}
        guildHistory={guildHistory}
        today="2026-09-26"
      />
    );
    const region = screen.getByRole("region", {
      name: "Guild history timeline, scrolls horizontally"
    });
    const [casualBar] = screen.getAllByRole("img", { name: /raid night/ });
    fireEvent.mouseEnter(casualBar!);
    scrollTo(region, 10);
    expect(
      document.querySelector(".dossier-guild-timeline-tooltip")
    ).not.toBeInTheDocument();
  });
});

it("colours the tooltip's character names by class", () => {
  render(
    <DossierCharacterProvider characters={characters}>
      <DossierGuildHistory
        characters={characters}
        guildHistory={guildHistory}
        today="2026-09-26"
      />
    </DossierCharacterProvider>
  );
  const [casualBar] = screen.getAllByRole("img", { name: /raid night/ });
  fireEvent.mouseEnter(casualBar!);
  const name = screen.getByText("Ryun", {
    selector: ".dossier-guild-timeline-tooltip .dossier-character-name"
  });
  expect(name).toHaveClass("dossier-character-name--priest");
  // A tooltip cannot be clicked, so its names are not links.
  expect(name.closest("a")).toBeNull();
});

it("shades alternate tiers across the background and names a tier on hover", () => {
  const { container } = render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const bands = [...container.querySelectorAll(".dossier-guild-timeline-band")];
  expect(bands.length).toBeGreaterThan(3);
  const shading = bands.map((band) =>
    band.classList.contains("dossier-guild-timeline-band--shaded")
  );
  expect(shading.every((shaded, index) => shaded !== shading[index - 1])).toBe(
    true
  );
  fireEvent.mouseEnter(bands[1]!);
  expect(screen.getByText(/^Tier: /)).toBeInTheDocument();
});

it("stretches to fill the section, and re-fits when the section resizes", () => {
  let width = 1300;
  const clientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth"
  );
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return width;
    }
  });
  const observers: (() => void)[] = [];
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      observers.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  try {
    const { container } = render(
      <DossierGuildHistory
        characters={characters}
        guildHistory={guildHistory}
        today="2026-09-26"
      />
    );
    const svgWidth = () =>
      container.querySelector("svg")?.getAttribute("width");
    expect(svgWidth()).toBe("1300");
    width = 1600;
    act(() => observers.forEach((callback) => callback()));
    expect(svgWidth()).toBe("1600");
  } finally {
    globalThis.ResizeObserver = original;
    if (clientWidth) {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
    }
  }
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

function currentMarkers() {
  const ring = (guild: string) =>
    screen.getByRole("img", {
      name: `${guild} today. 1 character in the latest snapshot`
    });
  const [casualBar, rancourBar] = screen.getAllByRole("img", {
    name: /raid night/
  });
  const barY = (bar: HTMLElement) =>
    Number(bar.querySelector("rect")?.getAttribute("y"));
  const ringY = (marker: HTMLElement) =>
    Number(marker.querySelector("circle")?.getAttribute("cy"));
  return {
    rancour: { bar: barY(rancourBar!), ring: ringY(ring("Rancour")) },
    casual: { bar: barY(casualBar!), ring: ringY(ring("SeriouslyCasual")) },
    label: (guild: string) => ring(guild).querySelector("text")?.textContent
  };
}

it("marks the guilds the latest snapshot holds, each at the end of its row", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const markers = currentMarkers();
  // Narrow, SeriouslyCasual's outside label pushes Rancour to the next row.
  expect(markers.casual.bar).not.toBe(markers.rancour.bar);
  expect(markers.casual.ring).toBe(markers.casual.bar + 10);
  expect(markers.rancour.ring).toBe(markers.rancour.bar + 10);
  expect(markers.label("Rancour")).toBeUndefined();
  expect(markers.label("SeriouslyCasual")).toBeUndefined();
});

it("gives a current guild's marker its own named row when a later guild ends its row", () => {
  withScroller(1300, () => {
    render(
      <DossierGuildHistory
        characters={characters}
        guildHistory={guildHistory}
        today="2026-09-26"
      />
    );
    const markers = currentMarkers();
    // Wide, Rancour follows SeriouslyCasual in the top row.
    expect(markers.casual.bar).toBe(markers.rancour.bar);
    expect(markers.rancour.ring).toBe(markers.rancour.bar + 10);
    expect(markers.label("Rancour")).toBeUndefined();
    // A ring at that row's end would read as Rancour's.
    expect(markers.casual.ring).toBeGreaterThan(markers.rancour.ring);
    expect(markers.label("SeriouslyCasual")).toBe("SeriouslyCasual");
  });
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
