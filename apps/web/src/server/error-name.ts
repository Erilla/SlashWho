/**
 * The error's class name, reduced to identifier characters and bounded in length.
 * Never its message, the request URL, the request body, or an upstream payload.
 */
export function errorName(error: unknown): string {
  const raw =
    error instanceof Error
      ? (error.constructor?.name ?? error.name)
      : typeof error;
  return raw.replaceAll(/[^A-Za-z0-9_]/g, "").slice(0, 64) || "unknown";
}
