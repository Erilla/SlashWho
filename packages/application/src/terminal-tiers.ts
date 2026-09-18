import type { TerminalTier } from "@slashwho/database";
import { raidTierConclusion } from "@slashwho/domain";

export type TerminalTierKill = Readonly<{
  raidId: string;
  raidName: string;
  killedAt: string;
}>;

export type TerminalTierInput = Readonly<{
  /** When the run that read these tiers completed. */
  at: Date;
  /**
   * How long after a kill its rankings are taken to have settled. A kill
   * younger than this is never terminal, whatever tier it belongs to.
   */
  settleMs: number;
  kills: readonly TerminalTierKill[];
  /** The run's history-scan limitation, if it reported one. */
  scanLimitation: string | null;
  /** Raids this run attributed a limitation to. */
  troubledRaidIds: readonly string[];
}>;

/**
 * Which tiers a run is allowed to stop re-querying.
 *
 * Three rules, all of which must hold, and none of which is an optimisation:
 *
 * 1. **The raid's current-content window has closed.** An unknown window is
 *    never concluded. Freezing evidence we cannot place in time is worse than
 *    re-querying it, and `current_content_window_unknown` is live on real
 *    characters today.
 * 2. **The run read the tier without incident.** A limitation attributed to a
 *    raid leaves that raid re-queryable however old it is; a limitation on the
 *    history scan leaves *every* raid re-queryable, because a truncated or
 *    drifted scan may be missing reports from any tier -- kills and wipes, not
 *    merely parses. This is what makes storing evidence indefinitely safe while
 *    collection is still imperfect: "is collection good enough yet" stops being
 *    a judgement call and becomes an invariant enforced per tier.
 * 3. **Every kill in the tier has settled.** Rankings move for a few days after
 *    a kill, and a percentile frozen early cannot be corrected without a
 *    rebuild.
 *
 * Note what rule 3 then accepts. A settled percentile is treated as final even
 * though the pool it ranks against keeps moving, and a world rank likewise.
 * That is a deliberate policy choice -- a reviewer wants what the applicant
 * achieved, not a figure that quietly re-rates itself for years -- and not a
 * property of the data.
 */
export function terminalTiersFrom(
  input: TerminalTierInput
): readonly TerminalTier[] {
  // A scan that did not finish may be missing reports from any tier, so
  // nothing this run saw can be trusted complete.
  if (input.scanLimitation !== null) return [];

  const settledBefore = input.at.getTime() - input.settleMs;
  const troubled = new Set(input.troubledRaidIds);
  const raids = new Map<string, { raidName: string; settled: boolean }>();
  for (const kill of input.kills) {
    const killedAt = Date.parse(kill.killedAt);
    // An undatable kill cannot be shown to have settled, so it holds its tier
    // open rather than being waved through.
    const settled = !Number.isNaN(killedAt) && killedAt < settledBefore;
    const seen = raids.get(kill.raidId);
    raids.set(kill.raidId, {
      raidName: seen?.raidName ?? kill.raidName,
      settled: seen ? seen.settled && settled : settled
    });
  }

  const marks: TerminalTier[] = [];
  for (const [raidId, raid] of [...raids].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (!raid.settled) continue;
    if (troubled.has(raidId)) continue;
    if (raidTierConclusion(raid.raidName, input.at) !== "concluded") continue;
    marks.push(
      { raidId, domain: "kills" },
      { raidId, domain: "parses" },
      { raidId, domain: "tier_bests" }
    );
  }
  return marks;
}

/**
 * The instant the report scan may stop at, or `undefined` for no early stop.
 *
 * Derived from the character's own stored kills rather than from the content
 * windows, which is both simpler and stricter. A tier only goes terminal for
 * kills after a run whose history scan raised no limitation, so the stored
 * kills of such a character are its whole history: the oldest kill in a raid
 * that is *not* terminal is therefore the oldest thing the scan still has to
 * reach, and everything below it is already held.
 *
 * With nothing terminal there is no saving to take, and stored kills may come
 * from a run that never finished, so the scan is left alone.
 */
export function killScanFloorFrom(
  terminal: readonly TerminalTier[],
  kills: readonly TerminalTierKill[]
): string | undefined {
  const terminalKillRaids = new Set(
    terminal
      .filter((tier) => tier.domain === "kills")
      .map((tier) => tier.raidId)
  );
  if (terminalKillRaids.size === 0 || kills.length === 0) return undefined;

  const outstanding = kills.filter(
    (kill) => !terminalKillRaids.has(kill.raidId)
  );
  // One unsettled tier below the newest terminal one means the scan must still
  // page past it, so the floor is that tier's oldest kill, not the newest
  // terminal boundary.
  return outstanding.length > 0
    ? outstanding.reduce(
        (oldest, kill) => (kill.killedAt < oldest ? kill.killedAt : oldest),
        outstanding[0]!.killedAt
      )
    : // Every tier held is terminal, so only a raid night newer than the
      // newest kill can still be worth a page.
      kills.reduce(
        (newest, kill) => (kill.killedAt > newest ? kill.killedAt : newest),
        kills[0]!.killedAt
      );
}
