import { canonicalCharacterId, type CharacterKey } from "@slashwho/domain";

export type RecordedWarcraftLogsCharacterId = Readonly<{
  key: CharacterKey;
  characterId: number;
}>;

export type SharedIdentityGroup<T> = Readonly<{
  primary: T;
  aliases: readonly T[];
}>;

/**
 * Collapses candidates whose keys last resolved to the same stable Warcraft
 * Logs character ID into one group (#423). A name and realm lookup that lands
 * on an ID another candidate already holds is the same character under a
 * former or later name, so it is a verified alias rather than a second row.
 *
 * A key with no recorded ID is never merged: the absence of an answer says
 * nothing about identity. Groups keep the position of their highest-ranked
 * member, so the caller's ordering survives the merge.
 */
export function groupBySharedWarcraftLogsId<T extends { key: CharacterKey }>(
  candidates: readonly T[],
  recorded: readonly RecordedWarcraftLogsCharacterId[],
  choosePrimary: (members: readonly T[]) => T
): readonly SharedIdentityGroup<T>[] {
  const ids = new Map(
    recorded.map((entry) => [
      canonicalCharacterId(entry.key),
      entry.characterId
    ])
  );
  const members = new Map<string, T[]>();
  const order: string[] = [];
  for (const candidate of candidates) {
    const id = canonicalCharacterId(candidate.key);
    const characterId = ids.get(id);
    const group =
      characterId === undefined ? `key\0${id}` : `wcl\0${characterId}`;
    const existing = members.get(group);
    if (existing) {
      existing.push(candidate);
      continue;
    }
    members.set(group, [candidate]);
    order.push(group);
  }
  return order.map((group) => {
    const all = members.get(group)!;
    const primary = choosePrimary(all);
    return { primary, aliases: all.filter((member) => member !== primary) };
  });
}
