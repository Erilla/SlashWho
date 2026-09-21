// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CollectionMonitorResponse } from "@slashwho/contracts";
import { createOperatorSessionCookie } from "../../../server/operator-session";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  redirect: vi.fn(),
  list: vi.fn()
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() })
}));
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
vi.mock("./collection-monitor-client", () => ({
  CollectionMonitorClient: ({
    initialMonitor
  }: {
    initialMonitor: CollectionMonitorResponse;
  }) => (
    <output data-testid="monitor-liveness">
      {initialMonitor.hasActiveRuns ? "active" : "terminal"}
    </output>
  )
}));

import CollectionMonitorPage from "./page";

const monitor: CollectionMonitorResponse = {
  generatedAt: "2026-09-20T12:00:00.000Z",
  hasActiveRuns: true,
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
  mocks.redirect.mockReset();
  mocks.list.mockReset();
  mocks.redirect.mockImplementation(() => {
    throw new Error("operator_login_redirect");
  });
  mocks.list.mockResolvedValue(monitor);
});

describe("CollectionMonitorPage", () => {
  it("does not load identities when the page request lacks operator authorization", async () => {
    mocks.headers.mockResolvedValue(
      new Headers({ "x-real-ip": "203.0.113.8" })
    );

    await expect(CollectionMonitorPage()).rejects.toThrow(
      "operator_login_redirect"
    );
    expect(mocks.redirect).toHaveBeenCalledOnce();
    expect(mocks.redirect).toHaveBeenCalledWith("/operations/login");
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("passes the active monitor snapshot to the client for the configured operator Bearer credential", async () => {
    mocks.headers.mockResolvedValue(
      new Headers({
        authorization: "Bearer operator-secret-that-is-at-least-32-characters"
      })
    );

    render(await CollectionMonitorPage());

    expect(screen.getByTestId("monitor-liveness")).toHaveTextContent("active");
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("loads the monitor for a valid browser session cookie", async () => {
    const config = {
      BOT_API_KEY: "operator-secret-that-is-at-least-32-characters",
      RATE_LIMIT_HASH_SECRET: "rate-limit-secret-that-is-32-chars"
    } as Parameters<typeof createOperatorSessionCookie>[1];
    const setCookie = createOperatorSessionCookie(config.BOT_API_KEY, config);
    mocks.headers.mockResolvedValue(
      new Headers({ cookie: setCookie!.split(";", 1)[0]! })
    );

    render(await CollectionMonitorPage());

    expect(screen.getByTestId("monitor-liveness")).toHaveTextContent("active");
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
