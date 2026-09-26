import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { errorName, installProcessErrorHandlers } from "./process-errors";

class DatabaseUnavailableError extends Error {}

describe("worker process error handlers", () => {
  it.each([
    ["uncaughtException", "worker_uncaught_exception"],
    ["unhandledRejection", "worker_unhandled_rejection"]
  ] as const)(
    "logs %s by error class only, then terminates",
    (processEvent, logEvent) => {
      // Break caught: an escaped error left only Node's unredacted stderr trace.
      const target = new EventEmitter();
      const info = vi.fn();
      const terminate = vi.fn();
      installProcessErrorHandlers(target, { info }, terminate);

      target.emit(
        processEvent,
        new DatabaseUnavailableError("postgres://user:secret@host/db")
      );

      expect(info).toHaveBeenCalledExactlyOnceWith({
        event: logEvent,
        errorName: "DatabaseUnavailableError"
      });
      expect(JSON.stringify(info.mock.calls)).not.toContain("secret");
      expect(terminate).toHaveBeenCalledExactlyOnceWith(1);
    }
  );

  it("names a non-Error rejection by its type, never its value", () => {
    expect(errorName("postgres://user:secret@host/db")).toBe("string");
    expect(errorName(undefined)).toBe("undefined");
    expect(errorName(null)).toBe("object");
  });
});
