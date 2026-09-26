import type { WarcraftLogsRateLimitResult } from "../types";
import {
  nonNegativeFiniteNumber,
  nonNegativeInteger,
  positiveFiniteNumber,
  record
} from "./primitives";

export function rateLimitFacts(value: unknown): WarcraftLogsRateLimitResult {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const rateLimitData = data && record(data.rateLimitData);
  const limitPerHour =
    rateLimitData && positiveFiniteNumber(rateLimitData.limitPerHour);
  // Fractional upstream. An integer check here would reject 9058.65 as drift.
  const pointsSpentThisHour =
    rateLimitData && nonNegativeFiniteNumber(rateLimitData.pointsSpentThisHour);
  const pointsResetInSeconds =
    rateLimitData && nonNegativeInteger(rateLimitData.pointsResetIn);
  if (
    limitPerHour === null ||
    pointsSpentThisHour === null ||
    pointsResetInSeconds === null
  ) {
    return { kind: "limitation", code: "schema_drift" };
  }
  return {
    kind: "rate_limit",
    limitPerHour,
    pointsSpentThisHour,
    pointsResetInSeconds
  };
}
