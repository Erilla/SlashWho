/**
 * Whether a Raider.IO logged encounter's roster can be shown (#732). A hidden
 * composition, a missing roster and an empty one all mean the same to a
 * reader: nobody can be shown, which is never "nobody was there". Decided
 * here once. The Raider.IO client applies it to each response, and the
 * dossier applies it again to the roster left once suppressed raiders are
 * taken off.
 */
export function isRosterShown(
  raidComps: boolean | null | undefined,
  members: readonly unknown[]
): boolean {
  return raidComps !== false && members.length > 0;
}
