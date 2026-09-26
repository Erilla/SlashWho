import type { ApplicantDossier } from "@slashwho/contracts";

type Raid = ApplicantDossier["raids"][number];
type Boss = Raid["bosses"][number];
type WipeEvidence = Extract<Boss, { state: "wipe" }>["wipe"];

/** A report's URL without its fight fragment, so its pulls share one key. */
export function reportKey(url: string): string {
  return url.split("#", 1)[0] ?? url;
}

/** Newest first, the order the page reads wipes in. */
export function sortWipes(wipes: readonly WipeEvidence[]): WipeEvidence[] {
  return [...wipes].sort(
    (a, b) =>
      b.attemptedAt.localeCompare(a.attemptedAt) ||
      b.reportUrl.localeCompare(a.reportUrl)
  );
}

/**
 * Folds a boss's wiped pulls into one per night, report and kill. A
 * progression boss carries every pull it was wiped on, often a thousand or
 * more, while the page shows one row per night, so a dossier ran to megabytes
 * of pulls nobody could see.
 *
 * The fold keeps exactly what the page reads: each kept pull is the night's
 * latest in its report, which is the one whose time and report link the page
 * shows, and it carries every character present in any pull it replaces. Pulls
 * are only folded when the page would file them under the same kill, which is
 * the first later kill from another report, so pulls either side of a kill
 * stay apart.
 */
export function compactDossierWipes(
  dossier: ApplicantDossier
): ApplicantDossier {
  return {
    ...dossier,
    raids: dossier.raids.map((raid) => ({
      ...raid,
      bosses: raid.bosses.map(compactBossWipes)
    }))
  };
}

function compactBossWipes(boss: Boss): Boss {
  if (boss.state === "kill") {
    if (!boss.wipes) return boss;
    const killTimes = (boss.firstKills ?? [boss.firstKill]).map(
      (kill) => kill.killedAt
    );
    // The number of kills after a pull identifies the gap between kills it
    // falls in, and so which kills the page can file it under.
    return {
      ...boss,
      wipes: compactWipes(
        boss.wipes,
        (wipe) =>
          killTimes.filter((killedAt) => killedAt > wipe.attemptedAt).length
      )
    };
  }
  if (boss.state === "wipe") {
    if (!boss.wipes) return boss;
    const [first, ...rest] = compactWipes(boss.wipes, () => 0);
    return first ? { ...boss, wipes: [first, ...rest] } : boss;
  }
  return boss;
}

function compactWipes(
  wipes: readonly WipeEvidence[],
  killSlot: (wipe: WipeEvidence) => number
): WipeEvidence[] {
  const kept = new Map<
    string,
    { wipe: WipeEvidence; characterKeys: Set<string> }
  >();
  for (const wipe of sortWipes(wipes)) {
    const key = `${wipe.attemptedAt.slice(0, 10)}|${reportKey(wipe.reportUrl)}|${killSlot(wipe)}`;
    let entry = kept.get(key);
    if (!entry) {
      entry = {
        wipe: { ...wipe, characters: [] },
        characterKeys: new Set()
      };
      kept.set(key, entry);
    }
    for (const character of wipe.characters) {
      const characterKey = `${character.region}/${character.realm}/${character.name}`;
      if (entry.characterKeys.has(characterKey)) continue;
      entry.characterKeys.add(characterKey);
      entry.wipe.characters.push(character);
    }
  }
  return [...kept.values()].map(({ wipe }) => wipe);
}
