// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DossierTierSearchControl } from "./dossier-tier-search-control";

afterEach(cleanup);

const searchedAt = "2026-09-23T06:00:00.000Z";
const searchableAgainAt = "2026-09-24T06:00:00.000Z";

describe("DossierTierSearchControl", () => {
  it("queues a search of the tier when pressed", async () => {
    const onSearch = vi
      .fn()
      .mockResolvedValue({ state: "queued", searchableAgainAt: null });
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
  });

  it("shows the dossier's queued, running and done states", () => {
    const onSearch = vi.fn();
    const { rerender } = render(
      <DossierTierSearchControl
        onSearch={onSearch}
        raidName="Nerub-ar Palace"
        tierSearch={{ state: "queued", searchedAt, searchableAgainAt }}
      />
    );
    expect(screen.getByRole("button")).toHaveTextContent("Search queued");
    expect(screen.getByRole("button")).toBeDisabled();

    rerender(
      <DossierTierSearchControl
        onSearch={onSearch}
        raidName="Nerub-ar Palace"
        tierSearch={{ state: "running", searchedAt, searchableAgainAt }}
      />
    );
    expect(screen.getByRole("button")).toHaveTextContent("Searching…");
    expect(screen.getByRole("status")).toHaveTextContent(
      /searching guild logs/i
    );

    rerender(
      <DossierTierSearchControl
        onSearch={onSearch}
        raidName="Nerub-ar Palace"
        tierSearch={{ state: "searched", searchedAt, searchableAgainAt }}
      />
    );
    expect(screen.getByRole("button")).toHaveTextContent("Searched");
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      /searched again after/i
    );
  });

  it("says why nothing was queued, and lets the reader try again", async () => {
    const onSearch = vi
      .fn()
      .mockResolvedValueOnce({ state: "busy", searchableAgainAt: null })
      .mockRejectedValueOnce(new Error("tier_search_failed"));
    render(
      <DossierTierSearchControl
        onSearch={onSearch}
        raidName="Nerub-ar Palace"
      />
    );

    await userEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
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
