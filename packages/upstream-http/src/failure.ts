/**
 * How a provider client reports that an upstream read failed. One shape for
 * every provider, so a caller that handles several -- discovery reads both
 * Raider.IO and Blizzard -- tells them apart with one guard rather than a
 * hand-written `"kind" in error` check per call site.
 *
 * Two rules decide whether a gateway method throws this or returns a result:
 *
 * - A lookup, whose only useful answer is the whole thing asked for, throws an
 *   {@link UpstreamError}. There is nothing partial to hand back.
 * - An evidence read, which can stop part-way and still hold evidence worth
 *   keeping, returns its provider's `limitation` union beside that evidence.
 *   A throw cannot carry what was already read, and a partial result must
 *   never remove verified kill evidence.
 */
export type UpstreamFailure =
  | { kind: "not_found" }
  /**
   * The upstream answered for the thing asked about and refused it, as
   * Raider.IO does for a profile its owner made private. Permanent: never
   * retried as an outage.
   */
  | { kind: "forbidden" }
  | {
      kind: "transient";
      status?: number;
      retryAfterMs?: number;
    }
  | { kind: "schema_drift" };

export type UpstreamFailureKind = UpstreamFailure["kind"];

export type UpstreamError = Error & UpstreamFailure;

const failureKinds: ReadonlySet<unknown> = new Set<UpstreamFailureKind>([
  "not_found",
  "forbidden",
  "transient",
  "schema_drift"
]);

/**
 * Whether a thrown value is an upstream failure. Structural rather than an
 * `instanceof` check: fakes and the domain's own decoders throw plain objects
 * of the same shape, and they must be read the same way.
 */
export function isUpstreamFailure(value: unknown): value is UpstreamFailure {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  return failureKinds.has(value.kind);
}

/**
 * Builds the error a provider client throws. The message names the provider
 * and the kind only, never the request: a URL can carry a credential.
 */
export function createUpstreamError(
  provider: string,
  failure: UpstreamFailure
): UpstreamError {
  return Object.assign(
    new Error(`${provider}_${failure.kind}`),
    failure
  ) as UpstreamError;
}
