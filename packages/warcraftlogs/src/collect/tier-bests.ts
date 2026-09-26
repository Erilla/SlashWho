import { tierZonePlan } from "../collection-plan";
import { isLimitation } from "../decode/primitives";
import { decodeZoneRankings, type ZoneScope } from "../decode/rankings";
import { toParseLimitation, type ParseLedger } from "../parse-ledger";
import { characterVariables, characterZoneParsesQuery } from "../queries";
import type { WarcraftLogsTierBestParse } from "../types";
import { unavailableOnTimeout, type CollectionRun } from "./context";

/**
 * The best parse per boss in each zone the run's kills reach, one request a
 * zone. Spends from `parseRequestCap`, leaving the rest for per-fight
 * hydration.
 */
export async function collectTierBests(
  run: CollectionRun,
  ledger: ParseLedger
): Promise<readonly WarcraftLogsTierBestParse[]> {
  const { key, lookup, options } = run;
  const plan = tierZonePlan(run.kills.values(), options);
  const tierBests: WarcraftLogsTierBestParse[] = [];
  // Zones the loop stopped before reaching were read by nobody, so none of
  // them may settle on the strength of this run.
  const troubleFrom = (zones: readonly ZoneScope[]) => {
    for (const zone of zones) ledger.troubleTierBests(String(zone.zoneId));
  };
  if (plan.unreached.length > 0) {
    ledger.raiseTier({ kind: "limitation", code: "parse_request_cap" });
    troubleFrom(plan.unreached);
  }
  for (const [index, zone] of plan.zones.entries()) {
    run.parseRequests += 1;
    const rankings = await run.counted("zone_rankings", () =>
      run.ctx
        .graphql(
          characterZoneParsesQuery(lookup),
          { ...characterVariables(lookup), zoneID: zone.zoneId },
          options.signal
        )
        .catch(unavailableOnTimeout(options.signal))
    );
    if (rankings.kind !== "success") {
      ledger.troubleTierBests(String(zone.zoneId));
      ledger.raiseTier(toParseLimitation(rankings));
      // The loop stops here, so every zone still queued was read by nobody.
      troubleFrom(plan.zones.slice(index + 1));
      break;
    }
    const decoded = decodeZoneRankings(
      rankings.value,
      zone,
      key,
      options.className
    );
    if (isLimitation(decoded)) {
      ledger.troubleTierBests(String(zone.zoneId));
      ledger.raiseTier(decoded);
      // Drift describes this one zone's response. Every other zone is a
      // separate request with its own answer, so the budget goes on reading
      // them rather than being abandoned over a shape one zone returned.
      if (decoded.code === "parse_schema_drift") continue;
      troubleFrom(plan.zones.slice(index + 1));
      break;
    }
    tierBests.push(...decoded);
  }
  return tierBests;
}
