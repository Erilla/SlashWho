import type {
  Repositories,
  StoredSnapshot,
  StoredSnapshotCharacter
} from "@slashwho/database";
import {
  canonicalCharacterId,
  type CharacterGuild,
  type CharacterKey
} from "@slashwho/domain";

import { groupBySharedWarcraftLogsId } from "./shared-warcraft-logs-identity";

export type DossierSubject = Readonly<{
  key: CharacterKey;
  displayName: string;
  className: string | null;
  guild: CharacterGuild | null;
  raiderIoUrl: string;
  source: StoredSnapshotCharacter["source"] | "submitted" | "manually_added";
  /**
   * Other dossier keys that resolved to this character's Warcraft Logs ID, so
   * are the same character under another name (#423). Each keeps its own
   * collection; the evidence is shown under this subject.
   */
  warcraftLogsAliases?: readonly CharacterKey[];
}>;

/** Highest level first, then by region, realm and name. */
export function compareByLevelThenKey(
  left: Readonly<{ level: number; key: CharacterKey }>,
  right: Readonly<{ level: number; key: CharacterKey }>
): number {
  return (
    right.level - left.level ||
    left.key.region.localeCompare(right.key.region, "en") ||
    left.key.realm.localeCompare(right.key.realm, "en") ||
    left.key.name.localeCompare(right.key.name, "en")
  );
}

/** Level only orders the list; it is not part of a dossier subject. */
export type RankedSubject = DossierSubject & Readonly<{ level: number }>;

export type ResolvedSubjects = Readonly<{
  snapshot: StoredSnapshot;
  selected: RankedSubject[];
  skipped: RankedSubject[];
  excludedOrdered: RankedSubject[];
  provisional: boolean;
}>;

export type SubjectRepositories = Pick<
  Repositories,
  "snapshots" | "manualConnections" | "evidence"
>;

/**
 * Another root's snapshot, re-rooted at a character it lists as a
 * Raider.IO-declared member, so a character with no discovery of its own
 * shows the account it was claimed on while that discovery runs. An
 * inferred membership is not enough to put another root's whole list under
 * this character's name. Nothing is stored: the view lasts one read, and
 * the character's own snapshot replaces it once published.
 */
function borrowSnapshot(
  key: CharacterKey,
  containing: StoredSnapshot | null | undefined
): StoredSnapshot | null {
  if (!containing) return null;
  const id = canonicalCharacterId(key);
  const member = containing.characters.find(
    (character) => canonicalCharacterId(character.key) === id
  );
  if (member?.source !== "claimed" && member?.source !== "declared_main")
    return null;
  const formerRootId = canonicalCharacterId(containing.rootKey);
  return {
    ...containing,
    rootKey: key,
    characters: containing.characters.map((character) => {
      const characterId = canonicalCharacterId(character.key);
      if (characterId === id) return { ...character, source: "input" };
      if (characterId === formerRootId)
        return { ...character, source: "claimed" };
      return character;
    })
  };
}

/**
 * The dossier's characters: each included identity in ranked order, split
 * at the display cap into `selected` and `skipped`, and the excluded ones.
 * Null when no snapshot contains the character yet. Reading and searching a
 * tier both go through here, so they can never disagree about who is in
 * the dossier.
 */
export async function legacyResolveSubjects(
  key: CharacterKey,
  repositories: SubjectRepositories,
  config: { DOSSIER_CHARACTER_CEILING: number }
): Promise<ResolvedSubjects | null> {
  const own = await repositories.snapshots.getCurrent(key);
  const snapshot =
    own ??
    borrowSnapshot(
      key,
      await repositories.snapshots.getCurrentDeclaringCharacter?.(key)
    );
  if (!snapshot) return null;
  const seen = new Set(
    snapshot.characters.map((character) => canonicalCharacterId(character.key))
  );
  // A manually connected character is a full participant, not a lone row.
  // Adding it starts a discovery run rooted at that character, which walks
  // its Raider.IO alts and fingerprints its Blizzard guild roster, so merge
  // that snapshot in as well. The root's own snapshot stays untouched: a
  // dossier is a view of the moment rather than a stored record.
  const manual: RankedSubject[] = [];
  const excluded: RankedSubject[] = [];
  const manualExcludedIds = new Set<string>();
  for (const character of await repositories.manualConnections.list(
    snapshot.rootKey
  )) {
    if (character.excluded) {
      manualExcludedIds.add(canonicalCharacterId(character.key));
    }
    const admit = (candidate: RankedSubject, into = manual) => {
      const id = canonicalCharacterId(candidate.key);
      if (seen.has(id)) return;
      seen.add(id);
      into.push(candidate);
    };
    // An undiscovered character has no snapshot to merge yet. Its own run
    // is still queued, and the next read picks the characters up.
    const connectedSnapshot = character.pending
      ? null
      : await repositories.snapshots.getCurrent(character.key);
    // A manual connection carries no guild of its own, and `seen` keeps its
    // row from being replaced by the one its own discovery wrote. Read the
    // guild across before admitting, or a manually added character would
    // show none however much is known about it.
    const connectedGuild =
      connectedSnapshot?.characters.find(
        (discovered) =>
          canonicalCharacterId(discovered.key) ===
          canonicalCharacterId(character.key)
      )?.guild ?? null;
    // An excluded character joins the list and nothing else, so the
    // exclusion can be reversed from the same row. Its own discoveries
    // still follow: excluding one character is not undoing the add, and
    // those characters stand on their own evidence.
    admit(
      { ...character, guild: connectedGuild, source: "manually_added" },
      character.excluded ? excluded : manual
    );
    if (character.pending) continue;
    for (const discovered of connectedSnapshot?.characters ?? []) {
      admit(discovered);
    }
  }

  const rootId = canonicalCharacterId(snapshot.rootKey);
  // Rank before applying the cap so the displayed list and evidence requests
  // prioritise the same characters without changing the immutable snapshot.
  const discoveredExclusions = new Set(
    (
      (await repositories.manualConnections.listDiscoveredExclusions?.(
        snapshot.rootKey
      )) ?? []
    ).map(canonicalCharacterId)
  );
  for (const id of manualExcludedIds) discoveredExclusions.add(id);
  const isExcluded = (character: RankedSubject) =>
    discoveredExclusions.has(canonicalCharacterId(character.key));
  const isRoot = (character: RankedSubject) =>
    canonicalCharacterId(character.key) === rootId;
  const ordered = [...snapshot.characters, ...manual].sort((left, right) => {
    const rootOrder =
      Number(canonicalCharacterId(right.key) === rootId) -
      Number(canonicalCharacterId(left.key) === rootId);
    return rootOrder || compareByLevelThenKey(left, right);
  });
  // Keys that resolved to one Warcraft Logs ID are one character under
  // several names (#423), so they share one row and one cap slot. A failed
  // read costs only the merge: every key is then listed on its own, as it
  // was before the IDs were known.
  const candidates = [...ordered, ...excluded];
  const recordedIds = await Promise.resolve()
    .then(
      () =>
        repositories.evidence.warcraftLogsCharacterIds?.(
          candidates.map((character) => character.key)
        ) ?? []
    )
    .catch(() => []);
  const identities = groupBySharedWarcraftLogsId(
    candidates,
    recordedIds,
    // The searched character is never renamed out from under its own
    // dossier. Otherwise an excluded key leads an excluded identity, so
    // the row's Include reverses the exclusion that hides it.
    (members) => members.find(isRoot) ?? members.find(isExcluded) ?? members[0]!
  ).map(({ primary, aliases }) => ({
    subject:
      aliases.length === 0
        ? primary
        : {
            ...primary,
            warcraftLogsAliases: aliases.map((alias) => alias.key)
          },
    // An exclusion on any of the names hides the character they share,
    // except the searched character, which a dossier cannot exclude.
    excluded: !isRoot(primary) && [primary, ...aliases].some(isExcluded)
  }));
  const includedOrdered = identities.flatMap((identity) =>
    identity.excluded ? [] : [identity.subject]
  );
  const excludedIdentities = identities.flatMap((identity) =>
    identity.excluded ? [identity.subject] : []
  );
  const selected = includedOrdered.slice(0, config.DOSSIER_CHARACTER_CEILING);
  const skipped = includedOrdered.slice(selected.length);
  // Excluded characters are ranked among themselves only, so one of them
  // never costs a researchable character its place under the ceiling.
  const excludedOrdered = [...excludedIdentities].sort(compareByLevelThenKey);
  return {
    snapshot,
    selected,
    skipped,
    excludedOrdered,
    provisional: own === null
  };
}
