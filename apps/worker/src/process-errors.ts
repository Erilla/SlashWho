type ErrorLogger = { info(value: Record<string, unknown>): void };

type ProcessEvents = {
  on(
    event: "uncaughtException" | "unhandledRejection",
    listener: (error: unknown) => void
  ): unknown;
};

/**
 * The error's class name, reduced to identifier characters and bounded in length.
 * Never its message: a startup or runtime error can carry a database URL,
 * upstream payload, or credential in its text.
 */
export function errorName(error: unknown): string {
  const raw =
    error instanceof Error
      ? (error.constructor?.name ?? error.name)
      : typeof error;
  return raw.replaceAll(/[^A-Za-z0-9_]/g, "").slice(0, 64) || "unknown";
}

/**
 * Registering either listener replaces Node's default crash, so both log a
 * structured record and then terminate, keeping an escaped error fatal.
 */
export function installProcessErrorHandlers(
  target: ProcessEvents,
  logger: ErrorLogger,
  terminate: (exitCode: number) => void
): void {
  target.on("uncaughtException", (error) => {
    logger.info({
      event: "worker_uncaught_exception",
      errorName: errorName(error)
    });
    terminate(1);
  });
  target.on("unhandledRejection", (reason) => {
    logger.info({
      event: "worker_unhandled_rejection",
      errorName: errorName(reason)
    });
    terminate(1);
  });
}
