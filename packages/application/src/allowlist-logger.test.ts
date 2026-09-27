import { describe, expect, it } from "vitest";

import { allowlistedRecord, createAllowlistLogger } from "./allowlist-logger";

describe("allowlistedRecord", () => {
  const fields = new Set(["event", "durationMs"]);

  it("keeps only the named fields", () => {
    expect(
      allowlistedRecord(fields)({
        event: "x",
        durationMs: 1,
        characterName: "ryii"
      })
    ).toEqual({ event: "x", durationMs: 1 });
  });

  it("keeps a field a pattern admits, matched against the whole name", () => {
    const record = allowlistedRecord(fields, { patterns: [/^db[A-Za-z]*Ms$/] });
    expect(record({ event: "x", dbMs: 2, dbMsExtra: 3 })).toEqual({
      event: "x",
      dbMs: 2
    });
  });

  it("sanitizes only what it kept", () => {
    const seen: Record<string, unknown>[] = [];
    const record = allowlistedRecord(fields, {
      sanitize: (kept) => {
        seen.push(kept);
        return { ...kept, event: "sanitized" };
      }
    });
    expect(record({ event: "x", secret: "s" })).toEqual({ event: "sanitized" });
    expect(seen).toEqual([{ event: "x" }]);
  });

  it("names dropped fields, sorted, only when asked to", () => {
    const input = { event: "x", zeta: 1, alpha: 2 };
    expect(allowlistedRecord(fields)(input)).toEqual({ event: "x" });
    expect(allowlistedRecord(fields, { reportDropped: true })(input)).toEqual({
      event: "x",
      droppedFields: ["alpha", "zeta"]
    });
    expect(
      allowlistedRecord(fields, { reportDropped: true })({ event: "x" })
    ).toEqual({ event: "x" });
  });
});

describe("createAllowlistLogger", () => {
  it("writes only allowlisted fields alongside pino's own", () => {
    const lines: string[] = [];
    const logger = createAllowlistLogger(new Set(["event"]), {
      write: (line: string) => lines.push(line)
    });

    logger.info({ event: "x", battleTag: "Name#1234" });

    expect(JSON.parse(lines[0]!)).toEqual({
      level: 30,
      time: expect.any(Number),
      event: "x"
    });
  });
});
