// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DossierRateLimitCountdown } from "./dossier-rate-limit-countdown";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("shows and updates the provider reset countdown", () => {
  render(
    <DossierRateLimitCountdown
      retryAt="2026-09-15T12:02:05.000Z"
      source="raiderio"
    />
  );

  expect(screen.getByText("Raider.IO limit resets in 2m 5s")).toBeVisible();

  act(() => vi.advanceTimersByTime(65_000));

  expect(screen.getByText("Raider.IO limit resets in 1m")).toBeVisible();
});

it("announces the countdown when it starts and when it finishes, not every tick", () => {
  render(
    <DossierRateLimitCountdown
      retryAt="2026-09-15T12:02:05.000Z"
      source="warcraft_logs"
    />
  );

  const status = screen.getByRole("status");
  expect(status).toHaveTextContent(
    "Warcraft Logs limit reached. It resets in 2m 5s."
  );
  // The ticking text sits outside the live region.
  expect(status).not.toContainElement(
    screen.getByText("Warcraft Logs limit resets in 2m 5s")
  );
  const changes = vi.fn();
  const observer = new MutationObserver(changes);
  observer.observe(status, {
    childList: true,
    characterData: true,
    subtree: true
  });

  try {
    act(() => vi.advanceTimersByTime(65_000));
    expect(changes).not.toHaveBeenCalled();
    expect(status).toHaveTextContent(
      "Warcraft Logs limit reached. It resets in 2m 5s."
    );

    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Warcraft Logs limit has reset.");
    expect(screen.queryByText(/limit resets in/)).not.toBeInTheDocument();
  } finally {
    observer.disconnect();
  }
});

it("says nothing for a limit that had already reset", () => {
  render(
    <DossierRateLimitCountdown
      retryAt="2026-09-15T11:59:00.000Z"
      source="blizzard"
    />
  );

  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByText(/Blizzard/)).not.toBeInTheDocument();
});

it("announces a limit hit again with its new reset time", () => {
  const { rerender } = render(
    <DossierRateLimitCountdown
      retryAt="2026-09-15T12:00:30.000Z"
      source="raiderio"
    />
  );
  act(() => vi.advanceTimersByTime(30_000));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Raider.IO limit has reset."
  );

  rerender(
    <DossierRateLimitCountdown
      retryAt="2026-09-15T12:05:30.000Z"
      source="raiderio"
    />
  );

  expect(screen.getByRole("status")).toHaveTextContent(
    "Raider.IO limit reached. It resets in 5m."
  );
  expect(screen.getByText("Raider.IO limit resets in 5m")).toBeVisible();
});
