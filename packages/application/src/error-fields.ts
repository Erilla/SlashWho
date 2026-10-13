import { authoredErrorCode, driverErrorCode } from "./error-codes";

/** Bounded diagnostics shared by web and worker; never messages or payloads. */
export type ErrorFields = Readonly<{
  errorName: string;
  errorCode: string | null;
}>;

export function errorFields(error: unknown): ErrorFields {
  const name =
    error instanceof Error
      ? error.name && error.name !== "Error"
        ? error.name
        : (error.constructor?.name ?? error.name)
      : typeof error;
  return {
    errorName: name.replaceAll(/[^A-Za-z0-9_]/g, "").slice(0, 64) || "unknown",
    // SQLSTATEs come only from the driver's code, never an arbitrary message.
    errorCode:
      error instanceof Error
        ? (driverErrorCode((error as { code?: unknown }).code) ??
          authoredErrorCode(error.message))
        : null
  };
}
