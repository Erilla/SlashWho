import { parsePerformanceValues } from "../mappers";

// Parse enrichment is best-effort: a re-collection that is rate limited or
// capped re-finds the same fight with nothing attached. A fight is immutable,
// so a value already observed for it is never worsened by a later blank.
function mergeParseMetric(
  previous: ReturnType<typeof parsePerformanceValues>["damage"],
  incoming: ReturnType<typeof parsePerformanceValues>["damage"]
): ReturnType<typeof parsePerformanceValues>["damage"] {
  return incoming.state === "available" || previous.state !== "available"
    ? incoming
    : previous;
}

export function mergePerformanceValues(
  previous: ReturnType<typeof parsePerformanceValues>,
  incoming: ReturnType<typeof parsePerformanceValues>
): ReturnType<typeof parsePerformanceValues> {
  return {
    spec: incoming.spec ?? previous.spec,
    damage: mergeParseMetric(previous.damage, incoming.damage),
    healing: mergeParseMetric(previous.healing, incoming.healing),
    bossDamage: mergeParseMetric(previous.bossDamage, incoming.bossDamage)
  };
}
