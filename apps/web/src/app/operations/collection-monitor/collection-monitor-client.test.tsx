// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CollectionMonitorResponse } from "@slashwho/contracts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() })
}));

import { CollectionMonitorClient } from "./collection-monitor-client";

const inFlightMonitor: CollectionMonitorResponse = {
  generatedAt: "2026-09-20T12:00:00.000Z",
  hasActiveRuns: true,
  inFlight: [
    {
      character: { region: "eu", realm: "silvermoon", name: "ryii" },
      status: "running",
      attempt: 1,
      startedAt: "2026-09-20T11:45:00.000Z",
      elapsedSeconds: 900,
      retryAfterAt: null
    }
  ],
  completed: [
    {
      character: { region: "us", realm: "area-52", name: "unrelated" },
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      completedAt: "2026-09-20T11:00:00.000Z",
      evidenceVersion: 13
    }
  ],
  failed: []
};

const partialMonitor: CollectionMonitorResponse = {
  generatedAt: "2026-09-20T12:01:00.000Z",
  hasActiveRuns: true,
  inFlight: [],
  completed: [
    {
      character: { region: "eu", realm: "silvermoon", name: "ryii" },
      state: "partial",
      limitationCode: "request_cap",
      parseLimitationCode: null,
      completedAt: "2026-09-20T12:01:00.000Z",
      evidenceVersion: 14
    },
    ...inFlightMonitor.completed
  ],
  failed: []
};

const completeMonitor: CollectionMonitorResponse = {
  ...partialMonitor,
  generatedAt: "2026-09-20T12:03:00.000Z",
  hasActiveRuns: false,
  completed: [
    {
      ...partialMonitor.completed[0]!,
      state: "complete",
      limitationCode: null,
      completedAt: "2026-09-20T12:03:00.000Z",
      evidenceVersion: 15
    },
    ...inFlightMonitor.completed
  ]
};

function mockFetchMonitor(...responses: CollectionMonitorResponse[]) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected_monitor_read");
    return Response.json(response, {
      headers: { "cache-control": "no-store" }
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("CollectionMonitorClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("moves the matching in-flight run into completed after a complete publication", async () => {
    // Break caught: an authoritative publication could leave the visible monitor stale.
    const fetchMock = mockFetchMonitor(completeMonitor);

    render(<CollectionMonitorClient initialMonitor={inFlightMonitor} />);
    await advance(1_000);

    expect(screen.getAllByText("complete")).not.toHaveLength(0);
    expect(screen.getByText("unrelated — area-52 (US)")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/operations/collection-monitor",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("shows a partial run's limitation and keeps polling through its continuation", async () => {
    // Break caught: partial evidence could be treated as terminal and never receive its completion.
    mockFetchMonitor(partialMonitor, completeMonitor);

    render(<CollectionMonitorClient initialMonitor={inFlightMonitor} />);
    await advance(0);
    expect(screen.getByText("request_cap")).toBeVisible();

    await advance(1_000);
    expect(screen.getAllByText("complete")).not.toHaveLength(0);
  });

  it("does not read an initially terminal monitor", async () => {
    // Break caught: a settled collection could continue making unauthorised background requests.
    const fetchMock = mockFetchMonitor(completeMonitor);

    render(<CollectionMonitorClient initialMonitor={completeMonitor} />);
    await advance(20_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("announces a newly terminal matching run once", async () => {
    // Break caught: assistive technology could miss a meaningful publication or hear it repeatedly.
    mockFetchMonitor(partialMonitor, completeMonitor);

    render(<CollectionMonitorClient initialMonitor={inFlightMonitor} />);
    await advance(0);
    expect(screen.getByRole("status")).toHaveTextContent(
      "ryii collection is partial."
    );

    await advance(1_000);
    expect(screen.getByRole("status")).toHaveTextContent(
      "ryii collection is complete."
    );
  });

  it("retains the last monitor snapshot after an unauthorized poll response", async () => {
    // Break caught: an expired session could clear the monitor or retry indefinitely.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<CollectionMonitorClient initialMonitor={inFlightMonitor} />);
    await advance(1_000);
    await advance(20_000);

    expect(screen.getByText("ryii — silvermoon (EU)")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your operator session is no longer authorized."
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
