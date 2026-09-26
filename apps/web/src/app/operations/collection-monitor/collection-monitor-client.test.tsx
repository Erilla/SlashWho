// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen
} from "@testing-library/react";
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
    },
    {
      character: { region: "us", realm: "illidan", name: "blocked" },
      status: "running",
      attempt: 1,
      startedAt: "2026-09-20T11:50:00.000Z",
      elapsedSeconds: 600,
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
  hasMoreCompleted: false,
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
  hasMoreCompleted: false,
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

const multipleTerminalMonitor: CollectionMonitorResponse = {
  ...completeMonitor,
  failed: [
    {
      character: { region: "us", realm: "illidan", name: "blocked" },
      errorCode: "warcraft_logs_unavailable",
      stoppedAt: "2026-09-20T12:03:00.000Z"
    }
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

  it("shows each in-flight run's current step without announcing it", () => {
    render(
      <CollectionMonitorClient
        initialMonitor={{
          ...inFlightMonitor,
          hasActiveRuns: false,
          inFlight: [
            {
              ...inFlightMonitor.inFlight[0]!,
              collectionProgress: [
                { id: "warcraft_logs_history", state: "completed" },
                { id: "warcraft_logs_fight_parses", state: "active" },
                { id: "publication", state: "pending" }
              ]
            },
            inFlightMonitor.inFlight[1]!
          ]
        }}
      />
    );

    const rowOf = (name: string) =>
      screen
        .getByRole("rowheader", { name: new RegExp(name, "i") })
        .closest("tr");
    const withSteps = rowOf("ryii");
    const withoutSteps = rowOf("blocked");
    expect(
      withSteps?.querySelector(".collection-progress-summary")
    ).toHaveTextContent("Reading per-fight parses");
    expect(
      withoutSteps?.querySelector(".collection-progress")
    ).not.toBeInTheDocument();
    // A table of runs polling together would otherwise read every one aloud.
    expect(withSteps?.querySelector('[role="status"]')).not.toBeInTheDocument();
  });

  it("moves the matching in-flight run into completed after a complete publication", async () => {
    // Break caught: an authoritative publication could leave the visible monitor stale.
    const fetchMock = mockFetchMonitor(completeMonitor);

    render(<CollectionMonitorClient initialMonitor={inFlightMonitor} />);
    await advance(1_000);

    expect(screen.getAllByText("complete")).not.toHaveLength(0);
    expect(screen.getByText("unrelated — area-52 (US)")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/operations/collection-monitor?completedLimit=50",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("shows a partial run's limitation and keeps polling through its continuation", async () => {
    // Break caught: partial evidence could be treated as terminal and never receive its completion.
    mockFetchMonitor(partialMonitor, completeMonitor);

    render(<CollectionMonitorClient initialMonitor={inFlightMonitor} />);
    await advance(1_000);
    expect(screen.getByText("request_cap")).toBeVisible();

    await advance(2_000);
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
    await advance(1_000);
    expect(screen.getByRole("status")).toHaveTextContent(
      "ryii collection is partial."
    );

    await advance(2_000);
    expect(screen.getByRole("status")).toHaveTextContent(
      "ryii collection is complete."
    );
  });

  it("announces every terminal transition published in one snapshot", async () => {
    // Break caught: a single authoritative publication could hide later terminal transitions from assistive technology.
    mockFetchMonitor(multipleTerminalMonitor);

    render(<CollectionMonitorClient initialMonitor={inFlightMonitor} />);
    await advance(1_000);

    expect(screen.getByRole("status")).toHaveTextContent(
      "ryii collection is complete. blocked collection is failed."
    );
  });

  it("does not announce an identical snapshot", async () => {
    // Break caught: unchanged data could create noisy repeated announcements.
    mockFetchMonitor(inFlightMonitor);

    render(<CollectionMonitorClient initialMonitor={inFlightMonitor} />);
    await advance(0);

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("does not announce a generated-at-only change", async () => {
    // Break caught: timestamp-only updates could create noisy repeated announcements.
    mockFetchMonitor({
      ...inFlightMonitor,
      generatedAt: "2026-09-20T12:00:01.000Z"
    });

    render(<CollectionMonitorClient initialMonitor={inFlightMonitor} />);
    await advance(0);

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
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

  describe("completed runs", () => {
    function completedRuns(
      count: number,
      from = 0
    ): CollectionMonitorResponse["completed"] {
      return Array.from({ length: count }, (_, index) => ({
        character: {
          region: "eu",
          realm: "silvermoon",
          name: `run${from + index}`
        },
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        completedAt: new Date(
          Date.UTC(2026, 8, 20, 12, 0, 0) - (from + index) * 60_000
        ).toISOString(),
        evidenceVersion: 13
      }));
    }

    const firstPage: CollectionMonitorResponse = {
      generatedAt: "2026-09-20T12:00:00.000Z",
      hasActiveRuns: false,
      inFlight: [],
      completed: completedRuns(50),
      hasMoreCompleted: true,
      failed: []
    };

    const secondPage: CollectionMonitorResponse = {
      ...firstPage,
      completed: completedRuns(60),
      hasMoreCompleted: false
    };

    function stubIntersectionObserver() {
      const observers: {
        callback: (entries: IntersectionObserverEntry[]) => void;
        root: Element | Document | null | undefined;
        disconnected: boolean;
      }[] = [];
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          private readonly record;
          constructor(
            callback: (entries: IntersectionObserverEntry[]) => void,
            options?: IntersectionObserverInit
          ) {
            this.record = {
              callback,
              root: options?.root,
              disconnected: false
            };
            observers.push(this.record);
          }
          observe() {}
          disconnect() {
            this.record.disconnected = true;
          }
        }
      );
      const intersect = async () => {
        const live = observers.filter((observer) => !observer.disconnected);
        await act(async () => {
          for (const observer of live) {
            observer.callback([
              { isIntersecting: true } as IntersectionObserverEntry
            ]);
          }
        });
        await advance(0);
      };
      return { observers, intersect };
    }

    it("scrolls within a capped region rather than growing the page", () => {
      render(<CollectionMonitorClient initialMonitor={firstPage} />);

      const region = screen.getByRole("region", { name: "Completed" });
      expect(region).toHaveClass("collection-monitor-table-scroll--capped");
      // Scrollable regions must be reachable without a pointer.
      expect(region).toHaveAttribute("tabindex", "0");
    });

    it("loads the next page of older runs when asked", async () => {
      // Break caught: without paging, older completed runs past the first page
      // would be unreachable from the monitor.
      const fetchMock = mockFetchMonitor(secondPage);
      render(<CollectionMonitorClient initialMonitor={firstPage} />);
      expect(screen.queryByText(/run55 —/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
      await advance(0);

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/operations/collection-monitor?completedLimit=100",
        expect.objectContaining({ cache: "no-store" })
      );
      expect(screen.getByText(/run55 —/)).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Load older runs" })
      ).not.toBeInTheDocument();
    });

    it("loads older runs as the end of the capped table scrolls into view", async () => {
      const fetchMock = mockFetchMonitor(secondPage);
      const { observers, intersect } = stubIntersectionObserver();
      render(<CollectionMonitorClient initialMonitor={firstPage} />);

      expect(observers[0]?.root).toBe(
        screen.getByRole("region", { name: "Completed" })
      );
      await intersect();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(screen.getByText(/run55 —/)).toBeInTheDocument();
    });

    it("keeps polling at the loaded depth", async () => {
      // Break caught: a poll at the first page's limit would snap the table
      // back to fifty rows while the operator is reading older ones.
      const fetchMock = mockFetchMonitor(
        { ...secondPage, hasMoreCompleted: true, hasActiveRuns: true },
        secondPage
      );
      render(<CollectionMonitorClient initialMonitor={firstPage} />);

      fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
      await advance(0);
      await advance(1_000);

      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/operations/collection-monitor?completedLimit=100",
        expect.anything()
      );
    });

    it("stops loading on scroll after a failed page until pressed again", async () => {
      // Break caught: the still-visible button re-arms the observer, so a
      // failing page would be re-requested in a tight loop.
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(Response.json(secondPage));
      vi.stubGlobal("fetch", fetchMock);
      const { intersect } = stubIntersectionObserver();
      render(<CollectionMonitorClient initialMonitor={firstPage} />);

      await intersect();
      await intersect();
      expect(fetchMock).toHaveBeenCalledOnce();

      fireEvent.click(screen.getByRole("button", { name: "Load older runs" }));
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/run55 —/)).toBeInTheDocument();
    });

    it("stops offering more once a read returns as many runs as it may", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async (input) => {
          const limit = Number(
            new URL(String(input), "https://slashwho.example").searchParams.get(
              "completedLimit"
            )
          );
          // Only the last read needs its full depth; rendering every
          // intermediate page in full makes the test crawl.
          return Response.json({
            ...firstPage,
            completed: completedRuns(limit === 1_000 ? limit : 50)
          });
        });
      vi.stubGlobal("fetch", fetchMock);
      render(<CollectionMonitorClient initialMonitor={firstPage} />);

      for (let page = 2; page <= 20; page += 1) {
        fireEvent.click(
          screen.getByRole("button", { name: "Load older runs" })
        );
        await advance(0);
      }

      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/operations/collection-monitor?completedLimit=1000",
        expect.anything()
      );
      expect(
        screen.queryByRole("button", { name: "Load older runs" })
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Showing the latest 1,000 completed runs.")
      ).toBeVisible();
    });
  });
});
