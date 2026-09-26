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

  expect(screen.getByRole("status")).toHaveTextContent(
    "Raider.IO limit resets in 2m 5s"
  );

  act(() => {
    vi.advanceTimersByTime(65_000);
  });

  expect(screen.getByRole("status")).toHaveTextContent(
    "Raider.IO limit resets in 1m"
  );
});
