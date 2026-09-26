import { EventEmitter } from "node:events";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createWebLogger } from "./logger";
import { installProcessErrorHandlers } from "./process-errors";

class UpstreamPayloadError extends Error {}

function capturedLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    }
  });
  return { logger: createWebLogger(destination), lines };
}

describe("web process error handlers", () => {
  it.each([
    ["uncaughtException", "web_uncaught_exception"],
    ["unhandledRejection", "web_unhandled_rejection"]
  ] as const)(
    "logs %s by error class through the allowlisted logger",
    async (processEvent, logEvent) => {
      // Break caught: an escaped error left only Next's unredacted stderr trace.
      const target = new EventEmitter();
      const { logger, lines } = capturedLogger();
      installProcessErrorHandlers(target, logger);

      target.emit(
        processEvent,
        new UpstreamPayloadError("Ryii-Draenor https://raider.io/...")
      );
      await new Promise((resolve) => setImmediate(resolve));

      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(record).toMatchObject({
        event: logEvent,
        errorName: "UpstreamPayloadError"
      });
      expect(lines[0]).not.toContain("Ryii");
    }
  );
});
