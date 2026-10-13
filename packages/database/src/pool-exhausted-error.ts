/** A connection could not be acquired before pg-pool's configured timeout. */
export class DatabasePoolExhaustedError extends Error {
  readonly errorCode = "db_pool_exhausted";

  constructor() {
    super("database_pool_exhausted");
    this.name = "DatabasePoolExhaustedError";
  }
}

export function isPoolAcquisitionTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "timeout exceeded when trying to connect" ||
      ("code" in error && error.code === "ETIMEDOUT"))
  );
}
