import { errorName } from "./error-name";

type ErrorLogger = { info(value: Record<string, unknown>): void };

type ProcessEvents = {
  on(
    event: "uncaughtException" | "unhandledRejection",
    listener: (error: unknown) => void
  ): unknown;
};

/**
 * Adds a structured, allowlisted record alongside the Next.js server's own
 * listeners. Those already keep the server running after an escaped error,
 * so these only log: exiting here would turn one bad request into an outage.
 */
export function installProcessErrorHandlers(
  target: ProcessEvents,
  logger: ErrorLogger
): void {
  target.on("uncaughtException", (error) => {
    logger.info({
      event: "web_uncaught_exception",
      errorName: errorName(error)
    });
  });
  target.on("unhandledRejection", (reason) => {
    logger.info({
      event: "web_unhandled_rejection",
      errorName: errorName(reason)
    });
  });
}
