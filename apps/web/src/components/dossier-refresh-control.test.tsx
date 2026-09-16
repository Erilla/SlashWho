// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DossierRefreshControl } from "./dossier-refresh-control";

afterEach(cleanup);

const now = new Date("2026-09-16T12:00:00.000Z");

describe("DossierRefreshControl", () => {
  it("says how long ago the evidence was collected", () => {
    render(
      <DossierRefreshControl
        lastCollectedAt="2026-09-16T11:54:00.000Z"
        now={() => now}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByText(/6 minutes ago/i)).toBeTruthy();
  });

  it("says so when nothing has been collected yet", () => {
    render(
      <DossierRefreshControl
        lastCollectedAt={null}
        now={() => now}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByText(/not collected yet/i)).toBeTruthy();
  });

  it("refreshes the character when pressed", async () => {
    const onRefresh = vi.fn().mockResolvedValue({ mode: "full" });
    render(
      <DossierRefreshControl
        lastCollectedAt="2026-09-16T11:00:00.000Z"
        now={() => now}
        onRefresh={onRefresh}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("cannot be pressed twice while a refresh is in flight", async () => {
    // Break caught: a second press would queue another collection against a
    // rate-limited upstream for no extra data.
    let release: (() => void) | undefined;
    const onRefresh = vi.fn(
      () =>
        new Promise<{ mode: "full" }>((resolve) => {
          release = () => resolve({ mode: "full" });
        })
    );
    render(
      <DossierRefreshControl
        lastCollectedAt="2026-09-16T11:00:00.000Z"
        now={() => now}
        onRefresh={onRefresh}
      />
    );

    const button = screen.getByRole("button", { name: /refresh/i });
    await userEvent.click(button);
    expect(button.hasAttribute("disabled")).toBe(true);
    await userEvent.click(button);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    release?.();
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  });

  it("reports a light refresh differently from a full one", async () => {
    // Break caught: the two do very different amounts of work, so saying
    // "refreshed" for both would misrepresent what just happened.
    const onRefresh = vi.fn().mockResolvedValue({ mode: "light" });
    render(
      <DossierRefreshControl
        lastCollectedAt="2026-09-16T11:58:00.000Z"
        now={() => now}
        onRefresh={onRefresh}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() =>
      expect(screen.getByText(/checked for new kills/i)).toBeTruthy()
    );
  });
});
