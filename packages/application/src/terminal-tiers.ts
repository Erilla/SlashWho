import type { TerminalTier } from "@slashwho/database";
import { raidTierConclusion } from "@slashwho/domain";

export type TerminalTierKill = Readonly<{
  raidId: string;
  raidName: string;
  killedAt: string;
}>;

/**
 * A stored wipe, as the scan floor weighs it. No raid name: a wipe never
 * settles a tier, it only holds the scan open, so the tier's conclusion is
 * never asked of it.
 */
export type TerminalTierWipe = Readonly<{
  raidId: string;
  attemptedAt: string;
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
  /**
   * Raids this run attributed a limitation to, per collection domain. Both
   * sets are parse-domain: nothing in the history scan attributes trouble to a
   * raid, because a scan that goes wrong may be missing reports from any tier
   * and so reports itself through `scanLimitation` instead.
   */
  troubledRaidIds: Readonly<{
    parses: readonly string[];
    tierBests: readonly string[];
  }>;
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
 * 2. **The run read the tier without incident, in that domain.** A limitation
 *    attributed to a raid leaves that raid re-queryable however old it is --
 *    but only for the domain it was raised against. Both trouble sets are
 *    parse-domain, so neither says anything about whether the raid's kills were
 *    fully discovered: kills come from the history scan alone, and a scan that
 *    goes wrong reports itself through `scanLimitation`, which leaves *every*
 *    raid re-queryable in *every* domain, because a truncated or drifted scan
 *    may be missing reports from any tier -- kills and wipes, not merely
 *    parses. This is what makes storing evidence indefinitely safe while
 *    collection is still imperfect: "is collection good enough yet" stops being
 *    a judgement call and becomes an invariant enforced per tier, per domain.
 *
 *    Conflating the two is what #304 was: a veteran exhausts the parse budget
 *    on every run, so every raid came back troubled, so nothing settled for
 *    kills, so the scan floor never engaged and the whole history was
 *    re-scanned forever.
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
  const troubledParses = new Set(input.troubledRaidIds.parses);
  const troubledTierBests = new Set(input.troubledRaidIds.tierBests);
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
    if (raidTierConclusion(raid.raidName, input.at) !== "concluded") continue;
    // Kills survive parse-domain trouble: the scan that found them raised no
    // limitation, which is the whole of what this mark rests on.
    marks.push({ raidId, domain: "kills" });
    if (!troubledParses.has(raidId)) marks.push({ raidId, domain: "parses" });
    if (!troubledTierBests.has(raidId)) {
      marks.push({ raidId, domain: "tier_bests" });
    }
  }
  return marks;
}

/**
 * The instant the report scan may stop at, or `undefined` for no early stop.
 *
 * Derived from the character's own stored kills rather than from the content
 * windows, which is both simpler and stricter.
 *
 * The one thing this rests on: **a tier goes terminal for kills only after a
 * run whose history scan raised no limitation at all.** That is now the sole
 * guard, so it is worth stating plainly rather than leaving among the others.
 * Parse-domain trouble deliberately does not block the kills mark -- kills come
 * from the history scan alone, so a zone request that failed or a hydration
 * budget that ran out says nothing about whether this raid's kills are
 * complete.
 *
 * A clean scan therefore means the stored kills of such a character are its
 * whole history: the oldest kill in a raid that is *not* terminal is the oldest
 * thing the scan still has to reach, and everything below it is already held.
 * A scan that truncates at its page cap raises `request_cap`, which settles
 * nothing in any domain, so an incomplete history can never be frozen here.
 *
 * "Kill" there has to be read as "kill or wipe". The publish carries a stored
 * wipe forward on the same condition it carries a stored kill -- the raid being
 * terminal for kills -- so the floor has to answer for both, or it stops the
 * scan above evidence nothing will carry. A raid a character has only ever
 * wiped in makes that plain: with no kill to settle it can never be marked
 * terminal, so the mark that would protect its wipes is unreachable (#326).
 *
 * With nothing terminal there is no saving to take, and stored kills may come
 * from a run that never finished, so the scan is left alone.
 */
export function killScanFloorFrom(
  terminal: readonly TerminalTier[],
  kills: readonly TerminalTierKill[],
  wipes: readonly TerminalTierWipe[] = []
): string | undefined {
  const terminalKillRaids = new Set(
    terminal
      .filter((tier) => tier.domain === "kills")
      .map((tier) => tier.raidId)
  );
  if (terminalKillRaids.size === 0 || kills.length === 0) return undefined;

  // Wipes count for exactly as much as kills here, because the publish keeps
  // them on exactly the same condition. Weighing kills alone let the floor
  // rise above a stored wipe in a raid that can never go terminal -- a raid a
  // character has only ever wiped in has no kill to settle, so the mark it
  // would need is unreachable -- and a complete publish then dropped it (#326).
  const held = [
    ...kills.map((kill) => ({ raidId: kill.raidId, at: kill.killedAt })),
    ...wipes.map((wipe) => ({ raidId: wipe.raidId, at: wipe.attemptedAt }))
  ];
  const outstanding = held.filter(
    (evidence) => !terminalKillRaids.has(evidence.raidId)
  );
  // One unsettled tier below the newest terminal one means the scan must still
  // page past it, so the floor is that tier's oldest evidence, not the newest
  // terminal boundary.
  return outstanding.length > 0
    ? outstanding.reduce(
        (oldest, evidence) => (evidence.at < oldest ? evidence.at : oldest),
        outstanding[0]!.at
      )
    : // Every tier held is terminal, so only a raid night newer than the
      // newest thing held can still be worth a page.
      held.reduce(
        (newest, evidence) => (evidence.at > newest ? evidence.at : newest),
        held[0]!.at
      );
}
