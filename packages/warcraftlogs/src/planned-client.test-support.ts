/**
 * The client as the evidence service drives it, for this package's suites.
 * They were written when the gateway planned its own parse work, so they pass
 * the plan's inputs as call options; this builds the service's real plan from
 * them, so what they assert about which zones and fights get a request still
 * holds against the policy production runs.
 */
import { createWarcraftLogsCollectionPlan } from "../../application/src/warcraftlogs-collection-plan";
import {
  createWarcraftLogsClient,
  type CreateWarcraftLogsClientOptions
} from "./client";
import type { WarcraftLogsGateway } from "./types";

type FirstKillOptions = Parameters<
  WarcraftLogsGateway["getFirstKillReports"]
>[1];

export type PlannedFirstKillOptions = Omit<FirstKillOptions, "plan"> &
  Readonly<{
    plan?: FirstKillOptions["plan"];
    hydratedFightUrls?: ReadonlySet<string>;
    collectedTierZones?: ReadonlyMap<string, string>;
    terminalRaidIds?: Readonly<{
      kills?: ReadonlySet<string>;
      parses: ReadonlySet<string>;
      tierBests: ReadonlySet<string>;
    }>;
    parseJournalRaidId?: string;
  }>;

export type PlannedWarcraftLogsClient = Omit<
  WarcraftLogsGateway,
  "getFirstKillReports"
> & {
  getFirstKillReports(
    key: Parameters<WarcraftLogsGateway["getFirstKillReports"]>[0],
    options: PlannedFirstKillOptions
  ): ReturnType<WarcraftLogsGateway["getFirstKillReports"]>;
};

export function createPlannedWarcraftLogsClient(
  options: CreateWarcraftLogsClientOptions
): PlannedWarcraftLogsClient {
  const client = createWarcraftLogsClient(options);
  return {
    ...client,
    getFirstKillReports: (
      key,
      {
        plan,
        hydratedFightUrls,
        collectedTierZones,
        terminalRaidIds,
        parseJournalRaidId,
        ...rest
      }
    ) =>
      client.getFirstKillReports(key, {
        ...rest,
        plan:
          plan ??
          createWarcraftLogsCollectionPlan({
            ...(hydratedFightUrls ? { hydratedFightUrls } : {}),
            ...(collectedTierZones ? { collectedTierZones } : {}),
            ...(terminalRaidIds ? { terminalRaidIds } : {}),
            ...(parseJournalRaidId !== undefined ? { parseJournalRaidId } : {})
          })
      })
  };
}
