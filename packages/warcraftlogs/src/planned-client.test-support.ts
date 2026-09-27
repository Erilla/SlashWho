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

/**
 * Serves report actors the way Warcraft Logs now does for the history scan.
 * The suites' fixtures carry each report's `masterData` inside its history
 * page, which the page query no longer asks for (#712). So the page is
 * answered without it, and the scan's `ReportActors` follow-up is answered
 * from what the page carried, without reaching the suite's own fetch. Every
 * suite therefore reads history through the path production takes, and a
 * suite counting its fetch calls still counts the requests it wrote.
 */
export function splitHistoryActors(
  fetch: typeof globalThis.fetch
): typeof globalThis.fetch {
  const actorsByCode = new Map<string, unknown>();
  return async (input, init) => {
    let body: { query?: string; variables?: Record<string, unknown> } = {};
    try {
      if (typeof init?.body === "string") {
        body = JSON.parse(init.body) as typeof body;
      }
    } catch {
      // The token request is form-encoded, and is not this wrapper's to read.
    }
    if (body.query?.includes("query ReportActors")) {
      const reportData = Object.fromEntries(
        Object.entries(body.variables ?? {}).map(([name, code]) => {
          const masterData = actorsByCode.get(String(code));
          return [
            name.replace(/^code/, "report"),
            masterData === undefined ? null : { code, masterData }
          ];
        })
      );
      return new Response(JSON.stringify({ data: { reportData } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    const response = await fetch(input, init);
    if (!body.query?.includes("query RecentReports") || !response.ok) {
      return response;
    }
    const value = (await response.json()) as {
      data?: {
        characterData?: {
          character?: { recentReports?: { data?: unknown } } | null;
        };
      };
    };
    const reports = value?.data?.characterData?.character?.recentReports?.data;
    if (Array.isArray(reports)) {
      for (const report of reports as Record<string, unknown>[]) {
        if (!report || typeof report !== "object") continue;
        if ("masterData" in report && typeof report.code === "string") {
          actorsByCode.set(report.code, report.masterData);
        }
        delete report.masterData;
      }
    }
    return new Response(JSON.stringify(value), {
      status: response.status,
      headers: response.headers
    });
  };
}

export function createPlannedWarcraftLogsClient(
  options: CreateWarcraftLogsClientOptions
): PlannedWarcraftLogsClient {
  const client = createWarcraftLogsClient({
    ...options,
    fetch: splitHistoryActors(options.fetch)
  });
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
