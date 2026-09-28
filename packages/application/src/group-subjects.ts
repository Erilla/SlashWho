import {
  canonicalCharacterId,
  pathStrengths,
  type CharacterKey,
  type GroupGraph,
  type LinkStrength
} from "@slashwho/domain";
import { compareByLevelThenKey, type RankedSubject } from "./dossier-subjects";
import { groupBySharedWarcraftLogsId } from "./shared-warcraft-logs-identity";

export type { GroupGraph };

export type GroupSubjects = Readonly<{
  selected: readonly RankedSubject[];
  skipped: readonly RankedSubject[];
  excluded: readonly RankedSubject[];
  research: Readonly<{
    state: "complete" | "partial";
    limitationCodes: readonly string[];
  }>;
}>;

/** A page's members: reach from `originId` within its group, never through a suppressed character. */
export function pageMembers(originId: string, graph: GroupGraph): Set<string> {
  if (graph.suppressed.has(originId)) return new Set();
  const group = graph.groupOf.get(originId);
  // No group assignment means nothing to walk into: every link's ends would
  // also read as ungrouped (`undefined === undefined`), so without this
  // guard the filter below would never skip them and the walk would leak
  // into unrelated, equally ungrouped characters.
  if (group === undefined) return new Set([originId]);
  const members = new Set<string>([originId]);
  const neighbours = new Map<string, string[]>();
  for (const link of graph.links) {
    if (
      graph.groupOf.get(link.a) !== group ||
      graph.groupOf.get(link.b) !== group
    )
      continue;
    neighbours.set(link.a, [...(neighbours.get(link.a) ?? []), link.b]);
    neighbours.set(link.b, [...(neighbours.get(link.b) ?? []), link.a]);
  }
  const queue = [originId];
  for (;;) {
    const node = queue.shift();
    if (node === undefined) break;
    for (const next of neighbours.get(node) ?? []) {
      if (members.has(next) || graph.suppressed.has(next)) continue;
      members.add(next);
      queue.push(next);
    }
  }
  return members;
}

const SOURCE_FOR: Record<LinkStrength, RankedSubject["source"]> = {
  raiderio: "claimed",
  fingerprint: "fingerprint",
  manual: "manually_added"
};

export function resolveGroupSubjects(
  originKey: CharacterKey,
  graph: GroupGraph,
  config: { DOSSIER_CHARACTER_CEILING: number }
): GroupSubjects | null {
  const originId = graph.idOf(originKey);
  if (!originId || graph.suppressed.has(originId)) return null;
  const members = pageMembers(originId, graph);
  const strengths = pathStrengths(
    originId,
    graph.links.filter((link) => members.has(link.a) && members.has(link.b))
  );
  const subject = (id: string): RankedSubject => {
    const character = graph.characters.get(id)!;
    return {
      key: character.key,
      displayName: character.displayName,
      className: character.className,
      guild: null,
      raiderIoUrl: character.raiderIoUrl,
      level: character.level,
      source:
        id === originId
          ? "input"
          : // A page member with no strength can't happen under one consistent
            // read of the graph; fall back to the weakest label so it can
            // only under-state, never over-state, the connection. Pure
            // function, no logger to record it with.
            SOURCE_FOR[strengths.get(id) ?? "fingerprint"]
    };
  };
  const isSelfExclusion = (makerId: string, targetId: string) =>
    graph.sharedIdentity(makerId).has(targetId);
  const excludedIds = new Set<string>();
  for (const row of graph.manual) {
    if (
      row.excluded &&
      members.has(row.makerId) &&
      !isSelfExclusion(row.makerId, row.targetId)
    )
      excludedIds.add(row.targetId);
  }
  for (const row of graph.discoveredExclusions) {
    if (members.has(row.makerId) && !isSelfExclusion(row.makerId, row.targetId))
      excludedIds.add(row.targetId);
  }
  excludedIds.delete(originId);
  const originCanonical = canonicalCharacterId(originKey);
  const ordered = [...members].map(subject).sort((left, right) => {
    const rootOrder =
      Number(canonicalCharacterId(right.key) === originCanonical) -
      Number(canonicalCharacterId(left.key) === originCanonical);
    return rootOrder || compareByLevelThenKey(left, right);
  });
  const recorded = [...members].flatMap((id) => {
    const wcl = graph.warcraftLogsIds.get(id);
    return wcl === undefined
      ? []
      : [{ key: graph.characters.get(id)!.key, characterId: wcl }];
  });
  const idByCanonical = new Map(
    [...members].map((id) => [
      canonicalCharacterId(graph.characters.get(id)!.key),
      id
    ])
  );
  const excludedSubject = (candidate: RankedSubject) =>
    excludedIds.has(
      idByCanonical.get(canonicalCharacterId(candidate.key)) ?? ""
    );
  const identities = groupBySharedWarcraftLogsId(
    ordered,
    recorded,
    (group) =>
      group.find(
        (candidate) => canonicalCharacterId(candidate.key) === originCanonical
      ) ??
      group.find(excludedSubject) ??
      group[0]!
  );
  const included: RankedSubject[] = [];
  const excluded: RankedSubject[] = [];
  for (const { primary, aliases } of identities) {
    const isOrigin = canonicalCharacterId(primary.key) === originCanonical;
    const row =
      aliases.length === 0
        ? primary
        : {
            ...primary,
            warcraftLogsAliases: aliases.map((alias) => alias.key)
          };
    if (!isOrigin && [primary, ...aliases].some(excludedSubject))
      excluded.push(row);
    else included.push(row);
  }
  const contributing = [...members].flatMap((id) => {
    const snapshot = graph.latestSnapshot.get(id);
    return snapshot ? [snapshot] : [];
  });
  const originHasComplete =
    graph.latestSnapshot.get(originId)?.state === "complete";
  const allComplete = contributing.every(
    (snapshot) => snapshot.state === "complete"
  );
  const limitationCodes = [
    ...new Set(
      contributing.flatMap((snapshot) =>
        snapshot.limitationCode ? [snapshot.limitationCode] : []
      )
    )
  ].sort();
  return {
    selected: included.slice(0, config.DOSSIER_CHARACTER_CEILING),
    skipped: included.slice(config.DOSSIER_CHARACTER_CEILING),
    excluded: excluded.sort(compareByLevelThenKey),
    research: {
      state: allComplete && originHasComplete ? "complete" : "partial",
      limitationCodes
    }
  };
}
