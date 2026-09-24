import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { withAccountMailClient } from "./account-mail-query";

describe("bounded account mail database work", () => {
  it("releases a late connection without starting work after cancellation", async () => {
    let connected!: (client: PoolClient) => void;
    const pool = {
      connect: () =>
        new Promise<PoolClient>((resolve) => {
          connected = resolve;
        })
    } as Pool;
    const controller = new AbortController();
    const action = vi.fn();
    const pending = withAccountMailClient(pool, controller.signal, action);
    controller.abort();
    await expect(pending).rejects.toThrow("account_mail_database_cancelled");
    const client = { release: vi.fn() } as unknown as PoolClient;
    connected(client);
    await Promise.resolve();
    expect(client.release).toHaveBeenCalledWith(true);
    expect(action).not.toHaveBeenCalled();
  });

  it("destroys an in-flight connection and handles a later query rejection once", async () => {
    const client = { release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const controller = new AbortController();
    let rejectQuery!: (error: Error) => void;
    const action = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectQuery = reject;
        })
    );
    const pending = withAccountMailClient(pool, controller.signal, action);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow("account_mail_database_cancelled");
    rejectQuery(new Error("connection terminated"));
    await Promise.resolve();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("bounds acquisition even without a caller cancellation signal", async () => {
    vi.useFakeTimers();
    try {
      const pool = {
        connect: () => new Promise(() => undefined)
      } as unknown as Pool;
      const pending = withAccountMailClient(pool, undefined, vi.fn());
      const assertion = expect(pending).rejects.toThrow(
        "account_mail_database_cancelled"
      );
      await vi.advanceTimersByTimeAsync(10000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
