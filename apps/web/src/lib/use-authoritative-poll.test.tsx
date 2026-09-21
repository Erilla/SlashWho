// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type PollReadResult,
  retryAfterMilliseconds,
  useAuthoritativePoll
} from "./use-authoritative-poll";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

const visibilityStateDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState"
);

function setVisibilityState(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function startFirstPoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await flushPromises();
}

describe("useAuthoritativePoll", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();

    if (visibilityStateDescriptor) {
      Object.defineProperty(
        document,
        "visibilityState",
        visibilityStateDescriptor
      );
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("parses numeric and HTTP-date Retry-After headers", () => {
    // Break caught: client polls could disagree about a rate-limit cooldown.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z"));

    expect(
      retryAfterMilliseconds(
        new Response(null, { headers: { "retry-after": "15" } })
      )
    ).toBe(15_000);
    expect(
      retryAfterMilliseconds(
        new Response(null, {
          headers: { "retry-after": "Mon, 21 Sep 2026 12:00:15 GMT" }
        })
      )
    ).toBe(15_000);
  });

  it("does not read an initially terminal resource", () => {
    // Break caught: terminal snapshots could continue making unnecessary reads.
    const read =
      vi.fn<(signal: AbortSignal) => Promise<PollReadResult<string>>>();
    const onSnapshot = vi.fn();
    const onTerminalError = vi.fn();

    renderHook(() =>
      useAuthoritativePoll({ active: false, read, onSnapshot, onTerminalError })
    );

    setVisibilityState("hidden");
    setVisibilityState("visible");

    expect(read).not.toHaveBeenCalled();
  });

  it("waits one second before its first active read", async () => {
    // Break caught: mounting an active resource could bypass the bounded cadence.
    vi.useFakeTimers();
    const read = vi
      .fn<(signal: AbortSignal) => Promise<PollReadResult<string>>>()
      .mockResolvedValue({ kind: "snapshot", value: "partial" });

    renderHook(() =>
      useAuthoritativePoll({
        active: true,
        read,
        onSnapshot: vi.fn(),
        onTerminalError: vi.fn()
      })
    );

    expect(read).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(read).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("aborts an older request and ignores its response after a newer snapshot", async () => {
    // Break caught: a late response could replace a snapshot fetched after visibility returns.
    vi.useFakeTimers();
    const older = deferred<PollReadResult<string>>();
    const signals: AbortSignal[] = [];
    const read = vi
      .fn<(signal: AbortSignal) => Promise<PollReadResult<string>>>()
      .mockImplementationOnce((signal) => {
        signals.push(signal);
        return older.promise;
      })
      .mockResolvedValueOnce({ kind: "snapshot", value: "complete" });
    const onSnapshot = vi.fn();

    renderHook(() =>
      useAuthoritativePoll({
        active: true,
        read,
        onSnapshot,
        onTerminalError: vi.fn()
      })
    );
    await startFirstPoll();

    setVisibilityState("hidden");
    setVisibilityState("visible");
    await flushPromises();

    expect(read).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(onSnapshot).toHaveBeenLastCalledWith("complete");

    await act(async () => {
      older.resolve({ kind: "snapshot", value: "partial" });
      await Promise.resolve();
    });

    expect(onSnapshot).toHaveBeenLastCalledWith("complete");
  });

  it("uses Retry-After before the next request", async () => {
    // Break caught: a rate-limited source could be retried before its cooldown expires.
    vi.useFakeTimers();
    const read = vi
      .fn<(signal: AbortSignal) => Promise<PollReadResult<string>>>()
      .mockResolvedValueOnce({ kind: "retry", retryAfterMs: 15_000 })
      .mockResolvedValue({ kind: "snapshot", value: "complete" });

    renderHook(() =>
      useAuthoritativePoll({
        active: true,
        read,
        onSnapshot: vi.fn(),
        onTerminalError: vi.fn()
      })
    );
    await startFirstPoll();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("pauses while hidden and refreshes once when visible", async () => {
    // Break caught: background tabs could keep polling or wait for a stale timer on return.
    vi.useFakeTimers();
    const read = vi
      .fn<(signal: AbortSignal) => Promise<PollReadResult<string>>>()
      .mockResolvedValue({ kind: "snapshot", value: "partial" });

    renderHook(() =>
      useAuthoritativePoll({
        active: true,
        read,
        onSnapshot: vi.fn(),
        onTerminalError: vi.fn()
      })
    );
    await startFirstPoll();

    setVisibilityState("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(read).toHaveBeenCalledTimes(1);

    setVisibilityState("visible");
    await flushPromises();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404])("reports %i once as terminal", async (status) => {
    // Break caught: authorization and not-found responses could be retried forever.
    vi.useFakeTimers();
    const onTerminalError = vi.fn();
    const read = vi
      .fn<(signal: AbortSignal) => Promise<PollReadResult<string>>>()
      .mockResolvedValueOnce({
        kind: "terminal",
        response: new Response(null, { status })
      });

    renderHook(() =>
      useAuthoritativePoll({
        active: true,
        read,
        onSnapshot: vi.fn(),
        onTerminalError
      })
    );
    await startFirstPoll();

    expect(onTerminalError).toHaveBeenCalledWith(
      expect.objectContaining({ status })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not restart a terminal resource after visibility returns", async () => {
    // Break caught: visibility recovery could restart a terminal resource.
    vi.useFakeTimers();
    const read = vi
      .fn<(signal: AbortSignal) => Promise<PollReadResult<string>>>()
      .mockResolvedValueOnce({
        kind: "terminal",
        response: new Response(null, { status: 404 })
      });

    renderHook(() =>
      useAuthoritativePoll({
        active: true,
        read,
        onSnapshot: vi.fn(),
        onTerminalError: vi.fn()
      })
    );
    await startFirstPoll();

    setVisibilityState("hidden");
    setVisibilityState("visible");
    await flushPromises();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("retries rejected reads after the capped delay", async () => {
    // Break caught: a network failure could create a tight retry loop.
    vi.useFakeTimers();
    const read = vi
      .fn<(signal: AbortSignal) => Promise<PollReadResult<string>>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ kind: "snapshot", value: "complete" });

    renderHook(() =>
      useAuthoritativePoll({
        active: true,
        read,
        onSnapshot: vi.fn(),
        onTerminalError: vi.fn()
      })
    );
    await startFirstPoll();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("aborts scheduled work when unmounted", async () => {
    // Break caught: navigation could leave a request and timer running on the old page.
    vi.useFakeTimers();
    const pending = deferred<PollReadResult<string>>();
    let signal: AbortSignal | undefined;
    const read = vi.fn((nextSignal: AbortSignal) => {
      signal = nextSignal;
      return pending.promise;
    });

    const { unmount } = renderHook(() =>
      useAuthoritativePoll({
        active: true,
        read,
        onSnapshot: vi.fn(),
        onTerminalError: vi.fn()
      })
    );
    await startFirstPoll();
    unmount();

    expect(signal?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
