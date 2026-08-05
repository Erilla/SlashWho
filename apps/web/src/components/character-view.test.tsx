// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CharacterResource,
  HistoryPage,
  JobStatusResponse
} from "@slashwho/contracts";

import { CharacterPageClient } from "../app/characters/[region]/[realm]/[name]/character-page-client";

const jobId = "ca3ccfdf-1e8b-49b1-9729-459f42a104c0";
const snapshotId = "dd5d649e-456a-4caa-998d-5cb3c74db9f1";
const refreshedAt = "2026-08-04T18:07:00.000Z";

const staleResourceWithActiveJob: CharacterResource = {
  character: {
    region: "eu",
    realm: "silvermoon",
    name: "Ryii",
    className: "Druid",
    level: 80,
    raiderIoUrl: "https://raider.io/characters/eu/silvermoon/Ryii"
  },
  snapshot: {
    id: snapshotId,
    state: "complete",
    refreshedAt,
    characterCount: 2,
    characters: [
      {
        region: "eu",
        realm: "silvermoon",
        name: "Ryii",
        className: "Druid",
        level: 80,
        raiderIoUrl: "https://raider.io/characters/eu/silvermoon/Ryii"
      },
      {
        region: "eu",
        realm: "draenor",
        name: "Ryalts",
        className: "Mage",
        level: 80,
        raiderIoUrl: "https://raider.io/characters/eu/draenor/Ryalts"
      }
    ]
  },
  activeJob: {
    jobId,
    status: "running",
    statusUrl: `/api/v1/searches/${jobId}`
  }
};

const history: HistoryPage = {
  items: [
    {
      id: snapshotId,
      refreshedAt,
      state: "complete",
      characterCount: 2,
      url: `/api/v1/characters/eu/silvermoon/ryii/history/${snapshotId}`,
      characterUrl: "/characters/eu/silvermoon/ryii"
    },
    {
      id: "68412871-9047-49bc-b4de-c1a52a0bc2ee",
      refreshedAt: "2026-08-01T09:12:00.000Z",
      state: "partial",
      characterCount: 1,
      url: "/api/v1/characters/eu/silvermoon/ryii/history/68412871-9047-49bc-b4de-c1a52a0bc2ee",
      characterUrl: "/characters/eu/silvermoon/ryii"
    }
  ],
  nextCursor: null
};

function renderCharacter(
  resource: CharacterResource | null = staleResourceWithActiveJob,
  initialJob: JobStatusResponse | null = null
) {
  return render(
    <CharacterPageClient
      identity={{ region: "eu", realm: "silvermoon", name: "ryii" }}
      initialResource={resource}
      initialHistory={history}
      initialJob={initialJob}
      selectedSnapshotId={null}
    />
  );
}

describe("CharacterPageClient", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps stale characters and exact refresh history visible while refreshing", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined))
    );
    renderCharacter();

    expect(screen.getByRole("link", { name: "Ryii" })).toBeVisible();
    expect(screen.getByText("Refreshing")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Refresh history" })
    ).toBeVisible();
    const firstHistoryRow = screen.getAllByRole("listitem")[2];
    expect(within(firstHistoryRow).getByText("Complete")).toBeVisible();
    expect(within(firstHistoryRow).getByText("2 characters")).toBeVisible();
    expect(within(firstHistoryRow).getByRole("time")).toHaveAttribute(
      "datetime",
      refreshedAt
    );
    expect(
      screen.queryByText(/added|removed|profile guess/i)
    ).not.toBeInTheDocument();
  });

  it("renders partial snapshots distinctly without exposing provenance", () => {
    renderCharacter({
      ...staleResourceWithActiveJob,
      snapshot: { ...staleResourceWithActiveJob.snapshot, state: "partial" },
      activeJob: null
    });

    expect(screen.getAllByText("Partial")[0]).toBeVisible();
    expect(
      screen.queryByText(/source|owner|discord|battletag/i)
    ).not.toBeInTheDocument();
  });

  it("polls active states and replaces stale data when the refresh completes", async () => {
    vi.useFakeTimers();
    const responses = [
      { status: "queued" },
      { status: "running" },
      { status: "retrying", retryAt: "2026-08-04T18:08:00.000Z" },
      { status: "complete", completedAt: "2026-08-04T18:09:00.000Z" }
    ];
    const refreshedResource: CharacterResource = {
      ...staleResourceWithActiveJob,
      snapshot: {
        ...staleResourceWithActiveJob.snapshot,
        refreshedAt: "2026-08-04T18:09:00.000Z",
        characterCount: 1,
        characters: [staleResourceWithActiveJob.snapshot.characters[0]]
      },
      activeJob: null
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/searches/")) {
        const next = responses.shift() ?? { status: "complete" };
        return Response.json({
          jobId,
          characterUrl: "/characters/eu/silvermoon/ryii",
          createdAt: "2026-08-04T18:06:00.000Z",
          startedAt: null,
          completedAt: null,
          retryAt: null,
          error: null,
          ...next
        });
      }
      if (url.endsWith("/history")) return Response.json(history);
      return Response.json(refreshedResource);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCharacter();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });

    expect(screen.queryByText("Refreshing")).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Refresh status")).getByText("1 character")
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/characters/eu/silvermoon/ryii",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("keeps the active state and retries after a bounded rate-limit delay", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/v1/searches/")) {
        if (fetchMock.mock.calls.length === 1) {
          return new Response(
            JSON.stringify({
              error: { code: "rate_limited", message: "Too many requests." }
            }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": "30"
              }
            }
          );
        }
        return Response.json({
          jobId,
          status: "running",
          characterUrl: "/characters/eu/silvermoon/ryii",
          createdAt: "2026-08-04T18:06:00.000Z",
          startedAt: "2026-08-04T18:06:01.000Z",
          completedAt: null,
          retryAt: null,
          error: null
        });
      }
      return new Promise(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCharacter();

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Refreshing")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hydrates current and history data before cleaning up a completed poll", async () => {
    let resolveCurrent: ((response: Response) => void) | undefined;
    let resolveHistory: ((response: Response) => void) | undefined;
    const refreshedResource: CharacterResource = {
      ...staleResourceWithActiveJob,
      snapshot: {
        ...staleResourceWithActiveJob.snapshot,
        refreshedAt: "2026-08-04T18:09:00.000Z",
        characterCount: 1,
        characters: [staleResourceWithActiveJob.snapshot.characters[0]]
      },
      activeJob: null
    };
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/v1/searches/")) {
          return Promise.resolve(
            Response.json({
              jobId,
              status: "complete",
              characterUrl: "/characters/eu/silvermoon/ryii",
              createdAt: "2026-08-04T18:06:00.000Z",
              startedAt: "2026-08-04T18:06:01.000Z",
              completedAt: "2026-08-04T18:09:00.000Z",
              retryAt: null,
              error: null
            })
          );
        }
        if (url.endsWith("/history")) {
          return new Promise<Response>((resolve, reject) => {
            resolveHistory = resolve;
            options?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
          });
        }
        return new Promise<Response>((resolve, reject) => {
          resolveCurrent = resolve;
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    renderCharacter();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resolveCurrent).toBeDefined();
    expect(resolveHistory).toBeDefined();

    await act(async () => {
      resolveCurrent?.(Response.json(refreshedResource));
      resolveHistory?.(Response.json(history));
    });

    await waitFor(() => {
      expect(
        within(screen.getByLabelText("Refresh status")).getByText("1 character")
      ).toBeVisible();
    });
    expect(screen.queryByText("Refreshing")).not.toBeInTheDocument();
  });

  it("shows a safe failed state when a job terminates without a snapshot", () => {
    const failed: JobStatusResponse = {
      jobId,
      status: "failed",
      characterUrl: "/characters/eu/silvermoon/ryii",
      createdAt: "2026-08-04T18:06:00.000Z",
      startedAt: "2026-08-04T18:06:01.000Z",
      completedAt: "2026-08-04T18:06:02.000Z",
      retryAt: null,
      error: {
        code: "character_not_found",
        message: "The character was not found."
      }
    };
    renderCharacter(null, failed);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The character was not found."
    );
    expect(
      screen.queryByText(/stack|diagnostic|upstream body/i)
    ).not.toBeInTheDocument();
  });
});
