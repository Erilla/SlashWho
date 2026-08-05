import { describe, expect, it } from "vitest";

import { updateActiveRetryDelay } from "./queue";

describe("pg-boss retry delay update", () => {
  it("fails safely when the active pg-boss row is not updated", async () => {
    // Break caught: a pg-boss schema/state drift could silently ignore Retry-After.
    const db = {
      async executeSql() {
        return { rows: [] };
      }
    };

    await expect(
      updateActiveRetryDelay(db, "00000000-0000-4000-8000-000000000001", 5)
    ).rejects.toThrow("retry_delay_update_failed");
  });
});
