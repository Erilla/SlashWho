import type {
  ApplicantDossier,
  CharacterKey,
  DossierCharacter
} from "@slashwho/contracts";

type Raid = ApplicantDossier["raids"][number];
type Boss = Raid["bosses"][number];
type KillBoss = Extract<Boss, { state: "kill" }>;
type Kill = KillBoss["firstKill"];
type Wipe = Extract<Boss, { state: "wipe" }>["wipe"];
type Parses = KillBoss["bestParses"];

/**
 * A boss whose collected evidence belongs only to characters the viewer has
 * hidden. It is a view state, not an evidence state: the dossier has logs for
 * the boss, so it must never read as `no_logs`.
 */
export type HiddenBoss = Readonly<
  Pick<Boss, "bossId" | "bossName" | "bossOrder" | "imageUrl"> & {
    state: "hidden";
  }
>;

export type VisibleBoss = Boss | HiddenBoss;

/** One id per character, whatever case its key arrived in. */
export function characterId(key: CharacterKey): string {
  return [key.region, key.realm, key.name]
    .map((part) => part.toLocaleLowerCase("en-US"))
    .join("/");
}

function namesOf(character: DossierCharacter): string[] {
  return [
    character.displayName,
    character.key.name,
    ...(character.historicAliases ?? []).map((alias) => alias.name),
    ...(character.warcraftLogsAliases ?? []).map((alias) => alias.name)
  ].map((name) => name.trim().toLocaleLowerCase("en-US"));
}

function keysOf(character: DossierCharacter): CharacterKey[] {
  return [
    character.key,
    ...(character.historicAliases ?? []),
    ...(character.warcraftLogsAliases ?? [])
  ];
}

/** Which of a dossier's characters the viewer has chosen to see. */
export type EvidenceFilter = Readonly<{
  isCharacterVisible: (key: CharacterKey) => boolean;
  /** Parses name their character without a realm, so they match by name. */
  isParseVisible: (name: string) => boolean;
  visibleCount: number;
  totalCount: number;
}>;

/**
 * The filter a set of hidden rows applies, or `null` when it hides nothing
 * listed. Excluded rows carry no evidence, so they are neither counted nor
 * hidden. A character the list does not hold stays visible: the filter hides
 * what the viewer picked, it does not guess at the rest.
 */
export function evidenceFilter(
  characters: readonly DossierCharacter[],
  hiddenIds: ReadonlySet<string>
): EvidenceFilter | null {
  const listed = characters.filter((character) => !character.excluded);
  const hidden = listed.filter((character) =>
    hiddenIds.has(characterId(character.key))
  );
  if (hidden.length === 0) return null;
  const visible = listed.filter((character) => !hidden.includes(character));

  // An alias belongs to its row, so hiding a row hides evidence recorded
  // under any of its names.
  const hiddenKeys = new Set(hidden.flatMap(keysOf).map(characterId));
  const hiddenNames = new Set(hidden.flatMap(namesOf));
  const visibleNames = new Set(visible.flatMap(namesOf));

  return {
    isCharacterVisible: (key) => !hiddenKeys.has(characterId(key)),
    isParseVisible: (name) => {
      const normalized = name.trim().toLocaleLowerCase("en-US");
      return !hiddenNames.has(normalized) || visibleNames.has(normalized);
    },
    visibleCount: visible.length,
    totalCount: listed.length
  };
}

function filterParses(parses: Parses, filter: EvidenceFilter): Parses {
  return parses.filter((parse) => filter.isParseVisible(parse.character));
}

function filterKills(kills: readonly Kill[], filter: EvidenceFilter): Kill[] {
  return kills.flatMap((kill) => {
    const characters = kill.characters.filter(filter.isCharacterVisible);
    return characters.length === 0
      ? []
      : [{ ...kill, characters, parses: filterParses(kill.parses, filter) }];
  });
}

/** Keeps the wipes' order, so the first is the one the dossier leads with. */
function filterWipes(wipes: readonly Wipe[], filter: EvidenceFilter): Wipe[] {
  return wipes.flatMap((wipe) => {
    const characters = wipe.characters.filter(filter.isCharacterVisible);
    return characters.length === 0 ? [] : [{ ...wipe, characters }];
  });
}

function hiddenBoss(boss: Boss): HiddenBoss {
  return {
    bossId: boss.bossId,
    bossName: boss.bossName,
    bossOrder: boss.bossOrder,
    imageUrl: boss.imageUrl,
    state: "hidden"
  };
}

function earliestKill(kills: readonly Kill[]): Kill | undefined {
  return [...kills].sort(
    (a, b) =>
      a.killedAt.localeCompare(b.killedAt) ||
      (a.reportUrl ?? "").localeCompare(b.reportUrl ?? "")
  )[0];
}

/**
 * A boss as the viewer's filter leaves it. Kills and wipes keep only those a
 * visible character was present for, with hidden characters and their parses
 * taken out. A kill boss left with only wipes reads as a wipe, which is what
 * the visible characters have; one left with nothing is `hidden`. Bosses with
 * no evidence to filter are returned as they are.
 */
export function filterBoss(
  boss: Boss,
  filter: EvidenceFilter | null
): VisibleBoss {
  if (!filter) return boss;
  switch (boss.state) {
    case "kill": {
      const kills = filterKills(boss.firstKills ?? [boss.firstKill], filter);
      const wipes = filterWipes(boss.wipes ?? [], filter);
      const firstKill = earliestKill(kills);
      if (firstKill) {
        return {
          ...boss,
          firstKill,
          ...(boss.firstKills ? { firstKills: kills } : {}),
          bestParses: filterParses(boss.bestParses, filter),
          ...(boss.wipes ? { wipes } : {})
        };
      }
      const [wipe] = wipes;
      if (!wipe) return hiddenBoss(boss);
      return {
        bossId: boss.bossId,
        bossName: boss.bossName,
        bossOrder: boss.bossOrder,
        imageUrl: boss.imageUrl,
        state: "wipe",
        wipe,
        wipes
      };
    }
    case "wipe": {
      const wipes = filterWipes(boss.wipes ?? [boss.wipe], filter);
      const [wipe] = wipes;
      if (!wipe) return hiddenBoss(boss);
      return { ...boss, wipe, wipes };
    }
    case "no_logs":
    case "incomplete":
      return boss;
  }
}
