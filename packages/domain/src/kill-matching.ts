import { lookupRaiderIoBoss } from "./raid-catalogue";

/**
 * How far a Warcraft Logs kill may sit from Raider.IO's first-defeated time
 * and still be the same kill. Wider than the minutes the two usually differ
 * by, because Raider.IO can be a whole hour off: it dates Ryun's Queen Azshara
 * 19:34Z against the log's 20:34Z (1 of 36 matched pairs, measured
 * 2026-09-23). Still inside one raid night.
 *
 * Shared by collection, which uses it to skip a search the stored kill
 * already answers, and by the dossier, which uses it to lend a Raider.IO
 * logged encounter's roster to the Warcraft Logs kill it matches (#732).
 */
export const STORED_KILL_MATCH_MS = 2 * 60 * 60 * 1_000;

/**
 * Whether a Raider.IO first kill is this Warcraft Logs kill (#732): the same
 * boss, named by Raider.IO's own slugs, within `STORED_KILL_MATCH_MS`. The
 * one place the rule is written. Collection uses it to leave a matched kill's
 * rank to the Warcraft Logs lookup, and the dossier uses it to lend the
 * matched kill a roster, so the two can never disagree about a kill.
 *
 * Comparing slugs rather than catalogue ids is what lets Raider.IO's one
 * Grong match either faction's Warcraft Logs kill. Who killed it is the
 * caller's to compare: collection holds one character, and the dossier many.
 */
export function matchesRaiderIoKill(
  raiderIo: Readonly<{ raidSlug: string; bossSlug: string; killedAt: string }>,
  warcraftLogs: Readonly<{
    raidName: string;
    bossName?: string;
    killedAt: string;
  }>
): boolean {
  if (warcraftLogs.bossName === undefined) return false;
  const boss = lookupRaiderIoBoss(warcraftLogs.raidName, warcraftLogs.bossName);
  return (
    boss?.raidSlug === raiderIo.raidSlug &&
    boss.bossSlug === raiderIo.bossSlug &&
    Math.abs(
      Date.parse(warcraftLogs.killedAt) - Date.parse(raiderIo.killedAt)
    ) <= STORED_KILL_MATCH_MS
  );
}
