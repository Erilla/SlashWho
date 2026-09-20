// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CollectionMonitorResponse } from "@slashwho/contracts";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  unauthorized: vi.fn(),
  list: vi.fn()
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ unauthorized: mocks.unauthorized }));
vi.mock("../../../server/container", () => ({
  getContainer: async () => ({ collectionMonitor: { list: mocks.list } })
}));
vi.mock("../../../server/config", () => ({
  loadWebConfig: () => ({
    application: {
      BOT_API_KEY: "operator-secret-that-is-at-least-32-characters",
      RATE_LIMIT_HASH_SECRET: "rate-limit-secret-that-is-32-chars"
    }
  })
}));

import CollectionMonitorPage, { CollectionMonitorView } from "./page";

const monitor: CollectionMonitorResponse = {
  generatedAt: "2026-09-20T12:00:00.000Z",
  inFlight: [
    {
      character: { region: "eu", realm: "silvermoon", name: "ryii" },
      status: "retrying",
      attempt: 2,
      startedAt: "2026-09-20T11:45:00.000Z",
      elapsedSeconds: 900,
      retryAfterAt: "2026-09-20T12:15:00.000Z"
    }
  ],
  completed: [
    {
      character: { region: "us", realm: "area-52", name: "done" },
      state: "partial",
      limitationCode: "request_cap",
      parseLimitationCode: "parse_request_cap",
      completedAt: "2026-09-20T11:00:00.000Z",
      evidenceVersion: 13
    }
  ],
  failed: [
    {
      character: { region: "eu", realm: "draenor", name: "broken" },
      errorCode: "warcraft_logs_unavailable",
      stoppedAt: "2026-09-20T10:00:00.000Z"
    }
  ]
};

afterEach(cleanup);

beforeEach(() => {
  mocks.headers.mockReset();
  mocks.unauthorized.mockReset();
  mocks.list.mockReset();
  mocks.unauthorized.mockImplementation(() => {
    throw new Error("operator_unauthorized");
  });
  mocks.list.mockResolvedValue(monitor);
});

describe("CollectionMonitorPage", () => {
  it("renders the three requested tables with only their requested columns", () => {
    render(<CollectionMonitorView monitor={monitor} />);

    const inFlight = screen.getByRole("table", {
      name: "In flight and pending"
    });
    const completed = screen.getByRole("table", { name: "Completed" });
    const failed = screen.getByRole("table", { name: "Failed" });

    expect(
      within(inFlight)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent)
    ).toEqual([
      "Character",
      "Status",
      "Attempt",
      "Started",
      "Elapsed",
      "Retry after"
    ]);
    expect(
      within(completed)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent)
    ).toEqual([
      "Character",
      "State",
      "Limitation",
      "Parse limitation",
      "Completed",
      "Evidence version"
    ]);
    expect(
      within(failed)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent)
    ).toEqual(["Character", "Error", "Stopped"]);

    expect(within(inFlight).getByText("15m")).toBeInTheDocument();
    expect(within(completed).getByText("request_cap")).toBeInTheDocument();
    expect(
      within(completed).getByText("parse_request_cap")
    ).toBeInTheDocument();
    expect(
      within(failed).getByText("warcraft_logs_unavailable")
    ).toBeInTheDocument();
  });

  it("does not load identities when the page request lacks operator authorization", async () => {
    mocks.headers.mockResolvedValue(
      new Headers({ "x-real-ip": "203.0.113.8" })
    );

    await expect(CollectionMonitorPage()).rejects.toThrow(
      "operator_unauthorized"
    );
    expect(mocks.unauthorized).toHaveBeenCalledOnce();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("loads the monitor for the configured operator Bearer credential", async () => {
    mocks.headers.mockResolvedValue(
      new Headers({
        authorization: "Bearer operator-secret-that-is-at-least-32-characters"
      })
    );

    render(await CollectionMonitorPage());

    expect(
      screen.getByRole("heading", { name: "Collection monitor" })
    ).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.unauthorized).not.toHaveBeenCalled();
  });
});
