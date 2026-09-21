// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type PollReadResult,
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

  it("aborts an older request and ignores its response after a newer snapshot", async () => {
    // Break caught: a late response could replace a snapshot fetched after visibility returns.
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
    await flushPromises();

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
    await flushPromises();

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
    await flushPromises();

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
    await flushPromises();

    expect(onTerminalError).toHaveBeenCalledWith(
      expect.objectContaining({ status })
    );
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
    await flushPromises();

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
    await flushPromises();
    unmount();

    expect(signal?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
