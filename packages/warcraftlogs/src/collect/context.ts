import type { CharacterKey } from "@slashwho/domain";

import { record } from "../decode/primitives";
import type { CharacterLookup } from "../queries";
import type { GraphqlResult, WarcraftLogsTransport } from "../transport";
import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsGateway,
  WarcraftLogsLimitation,
  WarcraftLogsQueryType,
  WarcraftLogsRequestEvent,
  WarcraftLogsWipeEvidence
} from "../types";

export type FirstKillOptions = Parameters<
  WarcraftLogsGateway["getFirstKillReports"]
>[1];

export type RankedKillOptions = Parameters<
  WarcraftLogsGateway["getRankedKillReports"]
>[1];

/**
 * What outlives a single call: the transport, the clock, and the caches that
 * one character's run can share with the next.
 */
export type ClientContext = Readonly<{
  graphql: WarcraftLogsTransport["graphql"];
  monotonic: () => number;
  caches: {
    // The zone catalogue is Warcraft Logs' own static data, the same for
    // every character, and each ranked walk used to ask for it afresh.
    zones?: { value: unknown; at: number };
    // One dossier tier press searches up to 30 characters, one run after
    // another, and alts share guilds: each run walked the same guild's
    // attendance across the same window. A walk that finished is kept for a
    // while and replayed. Only whole walks are kept, never a page on its own:
    // pages shift as reports are uploaded, so a kept page beside a fresh one
    // could skip a report at the seam. Which pages a walk reads depends on
    // report start times alone, so a replay asks for exactly the pages kept;
    // each character still judges each report by its own name. A report
    // uploaded since is missed until the walk expires, which costs discovery
    // only: a tier search can add evidence but never remove it.
    readonly attendanceWalks: Map<
      string,
      { pages: ReadonlyMap<number, unknown>; at: number }
    >;
  };
}>;

/**
 * Issues one request and reports it to `onRequest`. Counted per call rather
 * than inside the transport so the observer stays scoped to one run: the
 * client is a process-wide singleton, so a construction-level observer could
 * not attribute a request to the run that issued it. Every request is
 * reported, limitation or not -- it was issued and paid for either way. It
 * takes the request unissued so the clock starts with it.
 */
export async function observedRequest<T extends GraphqlResult>(
  monotonic: () => number,
  onRequest: ((event: WarcraftLogsRequestEvent) => void) | undefined,
  query: WarcraftLogsQueryType,
  issue: () => Promise<T>
): Promise<T> {
  const startedAt = monotonic();
  const result = await issue();
  const durationMs = Math.max(0, Math.round(monotonic() - startedAt));
  try {
    onRequest?.({
      query,
      limited: result.kind !== "success",
      ...(result.kind === "limitation" ? { limitationCode: result.code } : {}),
      durationMs
    });
  } catch {
    // A counter must never cost the collection it is measuring.
  }
  return result;
}

/**
 * A run's own deadline expiring mid-request is an upstream that did not
 * answer in time, reported like any other. A caller's cancellation still
 * throws.
 */
export function unavailableOnTimeout(
  signal: AbortSignal | undefined
): (error: unknown) => WarcraftLogsLimitation {
  return (error) => {
    if (record(signal?.reason)?.name !== "TimeoutError") throw error;
    return { kind: "limitation", code: "unavailable" };
  };
}

/** The state one `getFirstKillReports` call builds up across its phases. */
export type CollectionRun = {
  readonly ctx: ClientContext;
  readonly key: CharacterKey;
  readonly lookup: CharacterLookup;
  readonly options: FirstKillOptions;
  readonly counted: <T extends GraphqlResult>(
    query: WarcraftLogsQueryType,
    issue: () => Promise<T>
  ) => Promise<T>;
  readonly kills: Map<string, WarcraftLogsFirstKillEvidence>;
  readonly wipes: Map<string, WarcraftLogsWipeEvidence>;
  /**
   * Reports this run has already decoded. Hydrating one again through
   * attendance would re-read the same fights.
   */
  readonly scannedReportCodes: Set<string>;
  /**
   * Requests spent against `requestCap`. The history scan, the re-read of
   * stored reports and attendance recovery all draw on it.
   */
  historyRequests: number;
  /** Requests spent against `parseRequestCap`. */
  parseRequests: number;
};
