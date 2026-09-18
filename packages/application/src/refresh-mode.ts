/**
 * How much work a manual refresh should do for one character.
 *
 * `full` re-scans every report and re-hydrates parses. `light` reads only the
 * most recent page of reports, which catches a raid night that has happened
 * since the last collection without spending a whole history's worth of
 * requests against a rate-limited upstream.
 *
 * The cooldown is deliberately invisible to the reader: pressing refresh
 * during it still does something honest rather than refusing.
 */
/**
 * `rebuild` additionally forgets every terminal mark, so the character's whole
 * history is collected again across as many runs as the points allowance
 * allows. `refreshMode` never returns it: unlike the other two it is chosen by
 * the caller, and only by an operator running a script with credentials.
 *
 * That is a hard requirement rather than a preference. `/api/dossiers/.../refresh`
 * is unauthenticated, which is tolerable at one run per press and would not be
 * if a press could re-collect a character's entire history on demand.
 */
export type RefreshMode = "full" | "light" | "rebuild";

export function refreshMode(
  lastCompletedAt: Date | null,
  at: Date,
  cooldownMs: number
): RefreshMode {
  if (lastCompletedAt === null) return "full";
  const elapsed = at.getTime() - lastCompletedAt.getTime();
  // A negative elapsed means the stored time is ahead of ours. Clock skew
  // between web and worker must not open the expensive path.
  return elapsed >= cooldownMs ? "full" : "light";
}
