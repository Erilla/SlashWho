import { errorFields } from "@slashwho/application";

/** Same bounded name policy as the worker and web diagnostics pair. */
export function errorName(error: unknown): string {
  return errorFields(error).errorName;
}
