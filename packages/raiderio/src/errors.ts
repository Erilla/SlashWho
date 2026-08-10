export type RaiderIoFailure =
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | {
      kind: "transient";
      status?: number;
      retryAfterMs?: number;
    }
  | { kind: "schema_drift" };

export type RaiderIoError = Error & RaiderIoFailure;

export function isRaiderIoFailure(value: unknown): value is RaiderIoError {
  if (!(value instanceof Error) || !("kind" in value)) return false;

  return (
    value.kind === "not_found" ||
    value.kind === "forbidden" ||
    value.kind === "transient" ||
    value.kind === "schema_drift"
  );
}

export function createRaiderIoError(failure: RaiderIoFailure): RaiderIoError {
  return Object.assign(
    new Error(`raiderio_${failure.kind}`),
    failure
  ) as RaiderIoError;
}
