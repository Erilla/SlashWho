import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { one, withTransaction } from "./sql";

function fakePool(options: { failOn?: string } = {}) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      statements.push(text);
      if (text === options.failOn) throw new Error(`${text}_failed`);
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn()
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, client, statements };
}

describe("withTransaction", () => {
  it("commits and returns what the work returns", async () => {
    const { pool, client, statements } = fakePool();

    await expect(
      withTransaction(pool, async (tx) => {
        await tx.query("SELECT 1");
        return "done";
      })
    ).resolves.toBe("done");

    expect(statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and rethrows when the work throws", async () => {
    const { pool, client, statements } = fakePool();

    await expect(
      withTransaction(pool, async () => {
        throw new Error("work_failed");
      })
    ).rejects.toThrow("work_failed");

    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("keeps the original error when the rollback also fails", async () => {
    const { pool, client } = fakePool({ failOn: "ROLLBACK" });

    await expect(
      withTransaction(pool, async () => {
        throw new Error("work_failed");
      })
    ).rejects.toThrow("work_failed");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back a failed commit", async () => {
    const { pool, statements } = fakePool({ failOn: "COMMIT" });

    await expect(withTransaction(pool, async () => "done")).rejects.toThrow(
      "COMMIT_failed"
    );
    expect(statements).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
  });
});

describe("one", () => {
  it("returns the first row", () => {
    const result = { rows: [{ id: "a" }] } as QueryResult<{ id: string }>;
    expect(one(result)).toEqual({ id: "a" });
  });

  it("throws a named error for an empty result", () => {
    const result = { rows: [] } as unknown as QueryResult<{ id: string }>;
    expect(() => one(result, "account_missing")).toThrow("account_missing");
    expect(() => one(result)).toThrow("expected_row_missing");
  });
});
