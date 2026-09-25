// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type {
  DossierTierSearch,
  DossierTierSearchCharacter,
  DossierTierSearchOutcome,
  DossierTierSearchResponse
} from "@slashwho/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DossierTierSearchControl,
  tierSearchView
} from "./dossier-tier-search-control";

afterEach(cleanup);

const searchedAt = "2026-09-23T06:00:00.000Z";
const searchableAgainAt = "2026-09-24T06:00:00.000Z";
const key = (name: string) => ({
  region: "eu" as const,
  realm: "silvermoon",
  name
});

function tier(
  state: DossierTierSearch["state"],
  characters: readonly [string, DossierTierSearchCharacter["state"]][]
): DossierTierSearch {
  return {
    state,
    searchedAt,
    searchableAgainAt,
    characters: characters.map(([name, characterState]) => ({
      key: key(name.toLowerCase()),
      displayName: name,
      state: characterState,
      ...(characterState === "not_searched"
        ? {}
        : { searchedAt, searchableAgainAt })
    }))
  };
}

function answer(
  state: DossierTierSearchResponse["state"],
  characters: readonly [string, DossierTierSearchOutcome["outcome"]][]
): DossierTierSearchResponse {
  return {
    state,
    searchableAgainAt: null,
    characters: characters.map(([name, outcome]) => ({
      key: key(name.toLowerCase()),
      displayName: name,
      outcome,
      searchableAgainAt: outcome === "searched" ? searchableAgainAt : null
    }))
  };
}

describe("tierSearchView", () => {
  it("offers the search when no character has searched the tier", () => {
    expect(tierSearchView(undefined, null)).toMatchObject({
      label: "Search this tier",
      disabled: false,
      summary: null,
      characters: []
    });
  });

  it("never says searched while only some characters were", () => {
    // Break caught (#449): one character's search made the tier read
    // "Searched", though the others' gaps were never looked at.
    const view = tierSearchView(
      tier("partly_searched", [
        ["Ryii", "completed"],
        ["Alt", "not_searched"],
        ["Third", "not_searched"]
      ]),
      null
    );

    expect(view.label).toBe("Search remaining characters");
    expect(view.disabled).toBe(false);
    expect(view.summary).toBe("1 of 3 characters searched. 2 not searched.");
    expect(view.characters).toEqual([
      { name: "Ryii", status: "searched" },
      { name: "Alt", status: "not searched" },
      { name: "Third", status: "not searched" }
    ]);
  });

  it("counts each outcome while searches are in flight", () => {
    const view = tierSearchView(
      tier("running", [
        ["Ryii", "running"],
        ["Alt", "queued"],
        ["Third", "completed"],
        ["Fourth", "partial"],
        ["Fifth", "failed"],
        ["Sixth", "not_searched"]
      ]),
      null
    );

    expect(view).toMatchObject({ label: "Searching…", disabled: true });
    expect(view.summary).toBe(
      "2 of 6 characters searched. 1 running, 1 queued, 1 failed, 1 not searched."
    );
    expect(view.characters.map((character) => character.status)).toEqual([
      "searching",
      "queued",
      "searched",
      "searched, stopped at its request cap",
      "search failed",
      "not searched"
    ]);
    expect(
      tierSearchView(
        tier("queued", [
          ["Ryii", "queued"],
          ["Alt", "completed"]
        ]),
        null
      )
    ).toMatchObject({ label: "Search queued", disabled: true });
  });

  it("says searched only once every character was, and when it may run again", () => {
    const view = tierSearchView(
      tier("searched", [
        ["Ryii", "completed"],
        ["Alt", "failed"]
      ]),
      null
    );

    expect(view.label).toBe("Searched");
    expect(view.disabled).toBe(true);
    // A failed search still holds the limit, but is never counted as done.
    expect(view.summary).toMatch(
      /^1 of 2 characters searched\. 1 failed\. It can be searched again after .+\.$/
    );
  });

  it("gives each character the press skipped the reason it was skipped", () => {
    const view = tierSearchView(
      tier("queued", [
        ["Ryii", "queued"],
        ["Busy", "not_searched"],
        ["Empty", "not_searched"],
        ["Late", "not_searched"],
        ["Broken", "not_searched"],
        ["Cooling", "completed"]
      ]),
      answer("queued", [
        ["Ryii", "queued"],
        ["Busy", "busy"],
        ["Empty", "no_evidence"],
        ["Late", "over_limit"],
        ["Broken", "failed"],
        ["Cooling", "searched"]
      ])
    );

    expect(view.characters).toEqual([
      { name: "Ryii", status: "queued" },
      {
        name: "Busy",
        status: "skipped: another collection is running for it"
      },
      { name: "Empty", status: "skipped: nothing collected for it yet" },
      {
        name: "Late",
        status: "not queued: beyond the most one search may queue"
      },
      { name: "Broken", status: "failed: could not be queued" },
      { name: "Cooling", status: "searched" }
    ]);
    expect(view.summary).toBe(
      "1 of 6 characters searched. 1 queued, 1 failed, 3 skipped."
    );
  });

  it("shows a press's answer before the dossier catches up with it", () => {
    const view = tierSearchView(
      undefined,
      answer("queued", [
        ["Ryii", "queued"],
        ["Alt", "searched"],
        ["Third", "running"]
      ])
    );

    expect(view.label).toBe("Searching…");
    expect(view.disabled).toBe(true);
    expect(view.characters.map((character) => character.status)).toEqual([
      "queued",
      expect.stringMatching(/^searched recently; again after /),
      "searching"
    ]);
  });
});

describe("DossierTierSearchControl", () => {
  it("queues a search of the tier when pressed", async () => {
    const onSearch = vi.fn().mockResolvedValue(
      answer("queued", [
        ["Ryii", "queued"],
        ["Alt", "queued"]
      ])
    );
    render(
      <DossierTierSearchControl
        onSearch={onSearch}
        raidName="Nerub-ar Palace"
      />
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Search guild logs for Nerub-ar Palace"
      })
    );

    expect(onSearch).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole("button")).toHaveTextContent("Search queued")
    );
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "0 of 2 characters searched. 2 queued."
    );
    expect(
      screen.getByRole("list", { name: "Nerub-ar Palace search by character" })
    ).toHaveTextContent(/Ryii.*queued.*Alt.*queued/);
  });

  it("follows the dossier's state for every character", () => {
    const onSearch = vi.fn();
    const { rerender } = render(
      <DossierTierSearchControl
        onSearch={onSearch}
        raidName="Nerub-ar Palace"
        tierSearch={tier("running", [
          ["Ryii", "running"],
          ["Alt", "queued"]
        ])}
      />
    );
    expect(screen.getByRole("button")).toHaveTextContent("Searching…");
    expect(screen.getByRole("button")).toBeDisabled();

    rerender(
      <DossierTierSearchControl
        onSearch={onSearch}
        raidName="Nerub-ar Palace"
        tierSearch={tier("searched", [
          ["Ryii", "completed"],
          ["Alt", "completed"]
        ])}
      />
    );
    expect(screen.getByRole("button")).toHaveTextContent("Searched");
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      /all 2 characters searched.*searched again after/i
    );
  });

  it("says why nothing was queued, and lets the reader try again", async () => {
    const onSearch = vi
      .fn()
      .mockResolvedValueOnce(answer("busy", [["Ryii", "busy"]]))
      .mockRejectedValueOnce(new Error("tier_search_failed"));
    render(
      <DossierTierSearchControl
        onSearch={onSearch}
        raidName="Nerub-ar Palace"
      />
    );

    await userEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByRole("list")).toHaveTextContent(
        /another collection is running/i
      )
    );
    expect(screen.getByRole("button")).toBeEnabled();

    await userEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /could not be queued/i
      )
    );
    expect(screen.getByRole("button")).toBeEnabled();
  });
});
