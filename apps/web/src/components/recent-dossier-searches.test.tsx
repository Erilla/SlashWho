// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecentDossierSearches } from "./recent-dossier-searches";

const ryii = {
  character: { region: "eu", realm: "tarren-mill", name: "ryii" },
  displayName: "Ryii",
  searchedAt: "2026-09-26T12:05:00.000Z",
  state: "in_progress"
} as const;

const other = {
  character: { region: "us", realm: "area-52", name: "other" },
  displayName: "Other",
  searchedAt: "2026-09-25T08:30:00.000Z",
  state: "complete"
} as const;

function respondWith(...bodies: unknown[]) {
  // A body can be read once, so every call gets a response of its own; the
  // last body keeps answering once the list runs out.
  let call = 0;
  const fetch = vi.fn(async () =>
    Response.json(bodies[Math.min(call++, bodies.length - 1)])
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("RecentDossierSearches", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lists each character with its realm, start date and research state", async () => {
    vi.useFakeTimers();
    const fetch = respondWith({ searches: [ryii, other] });

    render(<RecentDossierSearches />);
    await flush();

    expect(fetch).toHaveBeenCalledWith(
      "/api/dossiers/recent",
      expect.objectContaining({ cache: "no-store" })
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0]!).getByRole("link", { name: "Ryii-Tarren Mill" })
    ).toHaveAttribute("href", "/dossiers/eu/tarren-mill/ryii");
    expect(rows[0]).toHaveTextContent("In progress");
    expect(within(rows[0]!).getByRole("cell", { name: /2026/ })).toBeTruthy();
    expect(
      within(rows[0]!).getByText((_, element) => element?.tagName === "TIME")
    ).toHaveAttribute("datetime", "2026-09-26T12:05:00.000Z");
    expect(
      within(rows[1]!).getByRole("link", { name: "Other-Area 52" })
    ).toHaveAttribute("href", "/dossiers/us/area-52/other");
    expect(rows[1]).toHaveTextContent("Completed");
  });

  it("turns a spinner into a tick when a later poll finds the research finished", async () => {
    // Break caught: the list was read once, so a search stayed "in progress"
    // on the landing page until the reader reloaded it.
    vi.useFakeTimers();
    respondWith(
      { searches: [ryii] },
      { searches: [{ ...ryii, state: "complete" }] }
    );

    render(<RecentDossierSearches />);
    await flush();
    expect(screen.getByRole("row", { name: /Ryii/ })).toHaveTextContent(
      "In progress"
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flush();

    expect(screen.getByRole("row", { name: /Ryii/ })).toHaveTextContent(
      "Completed"
    );
  });

  it("renders nothing until a search has been made", async () => {
    vi.useFakeTimers();
    respondWith({ searches: [] });

    const { container } = render(<RecentDossierSearches />);
    await flush();

    expect(container).toBeEmptyDOMElement();
  });
});
