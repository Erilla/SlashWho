import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether the module at `moduleUrl` is the script Node was asked to run.
 *
 * Compare filesystem paths rather than URL text: a URL's pathname keeps its
 * leading slash on POSIX and percent-encodes spaces, so comparing it with
 * `process.argv[1]` only ever matched on Windows.
 */
export function isMainModule(
  moduleUrl: string,
  invokedPath: string | undefined
): boolean {
  return invokedPath
    ? resolve(invokedPath) === fileURLToPath(moduleUrl)
    : false;
}

/**
 * Run `main` when the calling module is the invoked script, reporting a
 * failure as its error message and a non-zero exit code.
 */
export function runIfMain(
  moduleUrl: string,
  main: () => Promise<void>,
  failureCode: string
): void {
  if (!isMainModule(moduleUrl, process.argv[1])) return;
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : failureCode);
    process.exitCode = 1;
  });
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLocaleLowerCase("en-US")}_required`);
  return value;
}
