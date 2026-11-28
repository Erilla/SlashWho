// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within
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
  const bars = screen.getAllByRole("button", { name: /raid night/ });
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
  const [casualBar] = screen.getAllByRole("button", { name: /raid night/ });
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

it("opens a bar's guild on Raider.IO or Warcraft Logs from its context menu", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const [casualBar] = screen.getAllByRole("button", { name: /raid night/ });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  // fireEvent returns false when the handler cancels the event, which is
  // what keeps the browser's own menu from opening over the timeline's.
  expect(fireEvent.contextMenu(casualBar!)).toBe(false);
  const menu = screen.getByRole("menu", { name: "Links for SeriouslyCasual" });
  const raiderIo = within(menu).getByRole("menuitem", {
    name: "View SeriouslyCasual on Raider.IO (opens in a new tab)"
  });
  const warcraftLogs = within(menu).getByRole("menuitem", {
    name: "View SeriouslyCasual on Warcraft Logs (opens in a new tab)"
  });
  expect(raiderIo).toHaveAttribute(
    "href",
    "https://raider.io/guilds/eu/silvermoon/SeriouslyCasual"
  );
  expect(warcraftLogs).toHaveAttribute(
    "href",
    "https://www.warcraftlogs.com/guild/eu/silvermoon/SeriouslyCasual"
  );
  for (const link of [raiderIo, warcraftLogs]) {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  // Each site's official, unaltered mark (docs/brand-assets.md).
  expect(raiderIo.querySelector("img")).toHaveAttribute(
    "src",
    "/brand/raiderio-mark.png"
  );
  expect(warcraftLogs.querySelector("img")).toHaveAttribute(
    "src",
    "/brand/warcraft-logs-mark.png"
  );
  // A menu and a tooltip would compete for the same few lines of detail.
  expect(
    document.querySelector(".dossier-guild-timeline-tooltip")
  ).not.toBeInTheDocument();
  fireEvent.click(raiderIo);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("works a bar's context menu from the keyboard", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const [casualBar] = screen.getAllByRole("button", { name: /raid night/ });
  casualBar!.focus();
  fireEvent.contextMenu(casualBar!);
  const [raiderIo, warcraftLogs] = screen.getAllByRole("menuitem");
  expect(raiderIo).toHaveFocus();
  fireEvent.keyDown(raiderIo!, { key: "ArrowDown" });
  expect(warcraftLogs).toHaveFocus();
  fireEvent.keyDown(warcraftLogs!, { key: "ArrowDown" });
  expect(raiderIo).toHaveFocus();
  fireEvent.keyDown(raiderIo!, { key: "End" });
  expect(warcraftLogs).toHaveFocus();
  fireEvent.keyDown(warcraftLogs!, { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(casualBar).toHaveFocus();
  // Back on its bar, the focus tooltip returns with it.
  expect(
    document.querySelector(".dossier-guild-timeline-tooltip")?.textContent
  ).toContain("3 raid nights: Ryun");
});

it("returns focus to the bar when a menu link is chosen from the keyboard", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const [casualBar] = screen.getAllByRole("button", { name: /raid night/ });
  casualBar!.focus();
  fireEvent.contextMenu(casualBar!);
  // Enter on a link is a click with no pointer behind it, so detail is 0.
  fireEvent.click(screen.getAllByRole("menuitem")[0]!, { detail: 0 });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(casualBar).toHaveFocus();
  fireEvent.contextMenu(casualBar!);
  // A pointer click leaves focus where the pointer put it.
  fireEvent.click(screen.getAllByRole("menuitem")[0]!, { detail: 1 });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(casualBar).not.toHaveFocus();
});

it("opens and closes a bar's menu with a click", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const [casualBar] = screen.getAllByRole("button", { name: /raid night/ });
  expect(casualBar).toHaveAttribute("aria-haspopup", "menu");
  expect(casualBar).toHaveAttribute("aria-expanded", "false");
  fireEvent.pointerDown(casualBar!);
  fireEvent.click(casualBar!);
  expect(
    screen.getByRole("menu", { name: "Links for SeriouslyCasual" })
  ).toBeVisible();
  expect(casualBar).toHaveAttribute("aria-expanded", "true");
  // A second press on the same bar is its own click, not an outside one.
  fireEvent.pointerDown(casualBar!);
  fireEvent.click(casualBar!);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(casualBar).toHaveAttribute("aria-expanded", "false");
});

it("opens a bar's menu with Enter or Space", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const [casualBar] = screen.getAllByRole("button", { name: /raid night/ });
  for (const key of ["Enter", " "]) {
    casualBar!.focus();
    expect(fireEvent.keyDown(casualBar!, { key })).toBe(false);
    expect(screen.getAllByRole("menuitem")[0]).toHaveFocus();
    fireEvent.keyDown(screen.getAllByRole("menuitem")[0]!, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  }
});

it("opens a current guild's ring on Raider.IO or Warcraft Logs", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const ring = screen.getByRole("button", { name: /^Rancour today/ });
  expect(ring).toHaveAttribute("aria-haspopup", "menu");
  fireEvent.click(ring);
  const menu = screen.getByRole("menu", { name: "Links for Rancour" });
  expect(
    within(menu).getByRole("menuitem", { name: /on Raider\.IO/ })
  ).toHaveAttribute("href", "https://raider.io/guilds/eu/draenor/Rancour");
  expect(
    within(menu).getByRole("menuitem", { name: /on Warcraft Logs/ })
  ).toHaveAttribute(
    "href",
    "https://www.warcraftlogs.com/guild/eu/draenor/Rancour"
  );
  fireEvent.click(ring);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(fireEvent.contextMenu(ring)).toBe(false);
  expect(screen.getByRole("menu", { name: "Links for Rancour" })).toBeVisible();
  fireEvent.keyDown(screen.getAllByRole("menuitem")[0]!, { key: "Escape" });
  expect(ring).toHaveFocus();
});

it("closes a bar's context menu on a click elsewhere or a scroll", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const [casualBar, rancourBar] = screen.getAllByRole("button", {
    name: /raid night/
  });
  fireEvent.contextMenu(casualBar!);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.contextMenu(rancourBar!);
  expect(screen.getByRole("menu", { name: "Links for Rancour" })).toBeVisible();
  fireEvent.scroll(
    screen.getByRole("region", {
      name: "Guild history timeline, scrolls horizontally"
    })
  );
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("leaves the browser's own context menu everywhere but the bars", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const band = document.querySelector(".dossier-guild-timeline-band")!;
  expect(fireEvent.contextMenu(band)).toBe(true);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

/** Two lanes of bars: SeriouslyCasual raids alongside Rancour. */
function renderTwoLanes() {
  const [casualHistory, , rancourHistory] = guildHistory;
  return render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={[
        {
          ...casualHistory!,
          nights: nights(["2025-03-12", "2025-06-18"], [ryun])
        },
        rancourHistory!
      ]}
      today="2026-09-26"
    />
  );
}

/**
 * Lays the page out as jsdom cannot: a fixed header ending at
 * `headerBottom`, the timeline frame's top at `frameTop`, and a tooltip
 * `tooltipHeight` tall, all in viewport pixels.
 */
function withPage(
  // Read on every call, so a test can scroll the page by moving the frame.
  page: { headerBottom: number; frameTop: number; tooltipHeight: number },
  run: () => void
) {
  const rect = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "getBoundingClientRect"
  )!;
  const height = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight"
  );
  const header = document.createElement("header");
  header.className = "site-header";
  document.body.prepend(header);
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Element) {
      if (this === header)
        return DOMRect.fromRect({ height: page.headerBottom });
      if (this.classList.contains("dossier-guild-timeline-frame")) {
        return DOMRect.fromRect({ y: page.frameTop, height: 200 });
      }
      return rect.value.call(this);
    }
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("dossier-guild-timeline-tooltip")
        ? page.tooltipHeight
        : 0;
    }
  });
  try {
    run();
  } finally {
    Object.defineProperty(Element.prototype, "getBoundingClientRect", rect);
    if (height) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
    }
    header.remove();
  }
}

const tooltip = () =>
  document.querySelector<HTMLElement>(".dossier-guild-timeline-tooltip");

it("shows every tooltip above the frame, whatever its lane, when it fits under the header", () => {
  withPage({ headerBottom: 112, frameTop: 400, tooltipHeight: 60 }, () => {
    renderTwoLanes();
    const bars = screen.getAllByRole("button", { name: /raid night/ });
    const lanes = new Set(
      bars.map((bar) => bar.querySelector("rect")!.getAttribute("y"))
    );
    expect(lanes.size).toBeGreaterThan(1);
    const targets = [
      ...bars,
      ...screen.getAllByRole("button", { name: / today\./ }),
      document.querySelector(".dossier-guild-timeline-band")!
    ];
    for (const target of targets) {
      fireEvent.mouseEnter(target);
      // Out of the scroller, and placed above the frame by its stylesheet
      // rather than at a lane's y, so it never covers the chart.
      expect(tooltip()?.parentElement).toHaveClass(
        "dossier-guild-timeline-frame"
      );
      expect(tooltip()).not.toHaveClass(
        "dossier-guild-timeline-tooltip--below"
      );
      expect(tooltip()?.style.top).toBe("");
      fireEvent.mouseLeave(target.closest("svg")!);
    }
  });
});

it("puts a tooltip back beside its bar when the header leaves no room above the frame", () => {
  // 112 + 60 + the gap does not fit above a frame starting at 150.
  withPage({ headerBottom: 112, frameTop: 150, tooltipHeight: 60 }, () => {
    renderTwoLanes();
    const bars = screen.getAllByRole("button", { name: /raid night/ });
    const lower = bars.reduce((lowest, bar) =>
      Number(bar.querySelector("rect")!.getAttribute("y")) >
      Number(lowest.querySelector("rect")!.getAttribute("y"))
        ? bar
        : lowest
    );
    const barY = Number(lower.querySelector("rect")!.getAttribute("y"));
    act(() => lower.focus());
    expect(tooltip()).toHaveClass("dossier-guild-timeline-tooltip--below");
    expect(tooltip()?.style.top).toBe(`${barY + 24}px`);
  });
});

it("moves an open tooltip above the frame once the page scrolls it clear of the header", () => {
  let frameTop = 150;
  withPage(
    {
      headerBottom: 112,
      get frameTop() {
        return frameTop;
      },
      tooltipHeight: 60
    },
    () => {
      renderTwoLanes();
      const [bar] = screen.getAllByRole("button", { name: /raid night/ });
      act(() => bar!.focus());
      expect(tooltip()).toHaveClass("dossier-guild-timeline-tooltip--below");
      frameTop = 400;
      fireEvent.scroll(window);
      expect(tooltip()).not.toHaveClass(
        "dossier-guild-timeline-tooltip--below"
      );
      expect(tooltip()?.style.top).toBe("");
    }
  );
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
    const [casualBar] = screen.getAllByRole("button", { name: /raid night/ });
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
    const [casualBar] = screen.getAllByRole("button", { name: /raid night/ });
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
  const [casualBar] = screen.getAllByRole("button", { name: /raid night/ });
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
    screen.getByRole("button", {
      name: `${guild} today. 1 character in the latest snapshot`
    });
  const barY = (guild: string) =>
    Number(
      screen
        .getByRole("button", { name: new RegExp(`^${guild}\\. .*raid night`) })
        .querySelector("rect")
        ?.getAttribute("y")
    );
  const ringY = (marker: HTMLElement) =>
    Number(marker.querySelector("circle")?.getAttribute("cy"));
  return {
    rancour: { bar: barY("Rancour"), ring: ringY(ring("Rancour")) },
    casual: {
      bar: barY("SeriouslyCasual"),
      ring: ringY(ring("SeriouslyCasual"))
    },
    label: (guild: string) => ring(guild).querySelector("text")
  };
}

it("marks the guilds the latest snapshot holds, each at the end of its row", () => {
  // SeriouslyCasual raids alongside Rancour, so each has a row.
  const [casualHistory, , rancourHistory] = guildHistory;
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={[
        {
          ...casualHistory!,
          nights: nights(["2025-03-12", "2025-06-18"], [ryun])
        },
        rancourHistory!
      ]}
      today="2026-09-26"
    />
  );
  const markers = currentMarkers();
  expect(markers.casual.bar).not.toBe(markers.rancour.bar);
  expect(markers.casual.ring).toBe(markers.casual.bar + 10);
  expect(markers.rancour.ring).toBe(markers.rancour.bar + 10);
  expect(markers.label("Rancour")).toBeNull();
  expect(markers.label("SeriouslyCasual")).toBeNull();
});

it("gives a current guild's marker its own named row when a later guild ends its row", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const markers = currentMarkers();
  // Rancour follows SeriouslyCasual in the top row.
  expect(markers.casual.bar).toBe(markers.rancour.bar);
  expect(markers.rancour.ring).toBe(markers.rancour.bar + 10);
  expect(markers.label("Rancour")).toBeNull();
  // A ring at that row's end would read as Rancour's.
  expect(markers.casual.ring).toBeGreaterThan(markers.rancour.ring);
  const label = markers.label("SeriouslyCasual");
  expect(label?.textContent).toBe("SeriouslyCasual");
  // Drawn on the page, not on a bar: the bar label's fill would hide it.
  expect(label).toHaveClass("dossier-guild-timeline-ring-label");
  expect(label).not.toHaveClass("dossier-guild-timeline-label");
});

it("keeps a guild's colour when a character is hidden", () => {
  const colourOf = (name: string) =>
    screen
      .getAllByRole("button", {
        name: new RegExp(`^${name}\\. .*raid night`)
      })[0]
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
      .getAllByRole("button", { name: /raid night/ })
      .map((bar) => bar.getAttribute("aria-label")?.split(".")[0])
  ).toEqual(["Rancour"]);
  expect(
    screen.queryByRole("button", { name: /^SeriouslyCasual today/ })
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

const method = { name: "Method", region: "eu", realm: "tarren-mill" } as const;

const killedWith: NonNullable<ApplicantDossier["killedWith"]> = [
  {
    date: "2025-07-20",
    kills: [
      {
        raidName: "March on Quel'Danas",
        bossName: "Midnight Falls",
        killedAt: "2025-07-20T17:25:57.000Z",
        guild: method,
        characters: [ryii],
        loggedNights: [],
        log: "read"
      },
      {
        raidName: "The Voidspire",
        bossName: "Vaelgor & Ezzorak",
        killedAt: "2025-07-20T19:00:00.000Z",
        guild: casual,
        characters: [ryii, ryun],
        loggedNights: [],
        log: "read"
      }
    ]
  }
];

type KilledWithKill = NonNullable<
  ApplicantDossier["killedWith"]
>[number]["kills"][number];

function skulls() {
  return screen.queryAllByRole("img", { name: /^Raider\.IO kill/ });
}

function translateY(element: Element | null | undefined): number {
  const transform = element?.getAttribute("transform") ?? "";
  return Number(/translate\(\S+ (\S+)\)/.exec(transform)?.[1]);
}

it("draws a Raider.IO kill as a skull on its own row, under every guild's", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      killedWith={killedWith}
      today="2026-09-26"
    />
  );
  const [skull] = skulls();
  expect(skull).toBeDefined();
  const skullY = translateY(skull!.querySelector("g"));
  const rowTops = [
    ...document.querySelectorAll(
      ".dossier-guild-timeline-bar rect, .dossier-guild-timeline-current circle"
    )
  ].map((shape) => Number(shape.getAttribute("y") ?? shape.getAttribute("cy")));
  expect(rowTops.length).toBeGreaterThan(0);
  expect(Math.max(...rowTops)).toBeLessThan(skullY);
});

it("leaves the guild bars as they are beside a skull", () => {
  const labels = () =>
    screen
      .getAllByRole("button", { name: /raid night/ })
      .map((bar) => bar.getAttribute("aria-label"));
  const { rerender } = render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      today="2026-09-26"
    />
  );
  const before = labels();
  rerender(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      killedWith={killedWith}
      today="2026-09-26"
    />
  );
  expect(labels()).toEqual(before);
});

it("stacks a night's kills in one skull, naming each boss and guild", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      killedWith={killedWith}
      today="2026-09-26"
    />
  );
  const marks = skulls();
  expect(marks).toHaveLength(1);
  expect(marks[0]).toHaveAttribute(
    "aria-label",
    "Raider.IO kills on 20 Jul 2025. Midnight Falls with Method: Ryii. Vaelgor & Ezzorak with SeriouslyCasual: Ryii, Ryun. The guild bars don't show this kill for these characters"
  );
});

it("reaches a skull by keyboard and shows its tooltip on focus and hover", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      killedWith={killedWith}
      today="2026-09-26"
    />
  );
  const [skull] = skulls();
  expect(skull).toHaveAttribute("tabindex", "0");
  const tooltip = () =>
    document.querySelector(".dossier-guild-timeline-tooltip");
  fireEvent.focus(skull!);
  expect(tooltip()?.querySelector("strong")?.textContent).toBe(
    "Raider.IO kills on 20 Jul 2025"
  );
  expect(tooltip()?.textContent).toContain("Midnight Falls with Method: Ryii");
  expect(tooltip()?.textContent).toContain(
    "Vaelgor & Ezzorak with SeriouslyCasual: Ryii, Ryun"
  );
  fireEvent.blur(skull!);
  expect(tooltip()).not.toBeInTheDocument();
  fireEvent.mouseEnter(skull!);
  expect(tooltip()?.textContent).toContain("Midnight Falls with Method");
  fireEvent.mouseLeave(skull!.closest("svg")!);
  expect(tooltip()).not.toBeInTheDocument();
});

it("says Raider.IO names no guild, and what is missing of its log", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      killedWith={[
        {
          date: "2025-07-20",
          kills: [
            { ...killedWith[0]!.kills[0]!, guild: null, log: "not_read" },
            { ...killedWith[0]!.kills[1]!, log: "none" }
          ]
        }
      ]}
      today="2026-09-26"
    />
  );
  const label = skulls()[0]!.getAttribute("aria-label") ?? "";
  expect(label).toContain(
    "Midnight Falls, Raider.IO names no guild: Ryii, Raider.IO's log of it is not read yet"
  );
  expect(label).toContain(
    "Vaelgor & Ezzorak with SeriouslyCasual: Ryii, Ryun, Raider.IO has no log of it"
  );
  // Raider.IO not naming a guild is never read as the characters having none.
  expect(label).not.toMatch(/guildless|(?<!names )\bno guild\b/i);
});

it("draws no skull row without Raider.IO kills to mark", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      killedWith={[]}
      today="2026-09-26"
    />
  );
  expect(skulls()).toEqual([]);
  expect(
    document.querySelector(".dossier-guild-timeline-killed-with")
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/A skull on the bottom row/)).toBeNull();
});

it("leaves out a hidden character's Raider.IO kills", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      filter={evidenceFilter(characters, new Set(["eu/silvermoon/ryii"]))}
      guildHistory={guildHistory}
      killedWith={killedWith}
      today="2026-09-26"
    />
  );
  expect(skulls()[0]).toHaveAttribute(
    "aria-label",
    "Raider.IO kill on 20 Jul 2025. Vaelgor & Ezzorak with SeriouslyCasual: Ryun. The guild bars don't show this kill for these characters"
  );
});

// Rancour's bar runs 26 Jan to 11 Sept 2025 with Ryii; Pure Chaos has one
// night, 15 Mar 2024, and draws no bar.
function killOn(
  date: string,
  loggedNights: KilledWithKill["loggedNights"],
  who: readonly CharacterKey[] = [ryii]
): NonNullable<ApplicantDossier["killedWith"]> {
  return [
    {
      date,
      kills: [
        {
          ...killedWith[0]!.kills[0]!,
          killedAt: `${date}T20:00:00.000Z`,
          characters: [...who],
          loggedNights
        }
      ]
    }
  ];
}

it("draws no skull where a drawn guild bar already holds the character's night", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      killedWith={killOn("2025-05-04", [{ character: ryii, guild: rancour }])}
      today="2026-09-26"
    />
  );
  expect(skulls()).toEqual([]);
  expect(screen.queryByText(/A skull on the bottom row/)).toBeNull();
});

it("keeps the skull when the matched guild was seen on one night and draws no bar", () => {
  const pureChaos = guildHistory[1]!.guild;
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      killedWith={killOn("2024-03-15", [{ character: ryii, guild: pureChaos }])}
      today="2026-09-26"
    />
  );
  expect(skulls()).toHaveLength(1);
});

it("keeps the skull when the matched log names no guild", () => {
  // A Warcraft Logs kill naming no guild places the night in no guild, so
  // the domain lists no logged night for it.
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      killedWith={killOn("2025-05-04", [])}
      today="2026-09-26"
    />
  );
  expect(skulls()).toHaveLength(1);
});

it("keeps the skull when hiding characters takes the matched guild's bar away", () => {
  // SeriouslyCasual's bar is Ryun's alone; Ryii's one night there is not
  // enough for a bar of its own once Ryun is hidden.
  const history: NonNullable<ApplicantDossier["guildHistory"]> = [
    {
      guild: casual,
      nights: [
        { date: "2023-03-08", characters: [ryii, ryun] },
        { date: "2023-06-14", characters: [ryun] }
      ]
    },
    guildHistory[2]!
  ];
  const marks = killOn("2023-03-08", [{ character: ryii, guild: casual }]);
  const { rerender } = render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={history}
      killedWith={marks}
      today="2026-09-26"
    />
  );
  expect(skulls()).toEqual([]);
  rerender(
    <DossierGuildHistory
      characters={characters}
      filter={evidenceFilter(characters, new Set(["eu/silvermoon/ryun"]))}
      guildHistory={history}
      killedWith={marks}
      today="2026-09-26"
    />
  );
  expect(skulls()).toHaveLength(1);
});

it("names only the characters no bar holds on a shared kill", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={guildHistory}
      killedWith={killOn(
        "2025-05-04",
        [{ character: ryii, guild: rancour }],
        [ryii, ryun]
      )}
      today="2026-09-26"
    />
  );
  expect(skulls()[0]).toHaveAttribute(
    "aria-label",
    "Raider.IO kill on 4 May 2025. Midnight Falls with Method: Ryun. The guild bars don't show this kill for these characters"
  );
});

it("draws the skull row alone when no guild has more than one raid night", () => {
  render(
    <DossierGuildHistory
      characters={characters}
      guildHistory={[guildHistory[1]!]}
      killedWith={[{ ...killedWith[0]!, date: "2021-07-20" }]}
      today="2026-09-26"
    />
  );
  expect(
    screen.getByText(
      "No guild has more than one raid night in the stored evidence."
    )
  ).toBeInTheDocument();
  expect(skulls()).toHaveLength(1);
  expect(screen.queryAllByRole("button", { name: /raid night/ })).toEqual([]);
  // The axis starts in the skull's year.
  expect(
    [...document.querySelectorAll(".dossier-guild-timeline-year text")].map(
      (text) => text.textContent
    )[0]
  ).toBe("2021");
});
