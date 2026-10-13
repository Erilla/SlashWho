import {
  canonicalCharacterId,
  groupPageMembers,
  pathStrengths,
  toRaiderIoUrl,
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
export const pageMembers = groupPageMembers;

const SOURCE_FOR: Record<LinkStrength, RankedSubject["source"]> = {
  raiderio: "claimed",
  fingerprint: "fingerprint",
  manual: "manually_added"
};

const SOURCE_STRENGTH: Record<RankedSubject["source"], number> = {
  submitted: 3,
  input: 3,
  claimed: 2,
  declared_main: 2,
  profile_guess: 2,
  fingerprint: 1,
  manually_added: 0
};

export function resolveGroupSubjects(
  originKey: CharacterKey,
  graph: GroupGraph,
  config: { DOSSIER_CHARACTER_CEILING: number },
  logger?: { info(value: Record<string, unknown>): void }
): GroupSubjects | null {
  const originId = graph.idOf(originKey);
  if (!originId || graph.suppressed.has(originId)) return null;
  const members = pageMembers(originId, graph);
  const strengths = pathStrengths(
    originId,
    graph.links.filter((link) => members.has(link.a) && members.has(link.b))
  );
  const manualFacts = (targetKey: CharacterKey) => {
    const targetId = graph.idOf(targetKey);
    const origins = [
      ...graph.manual
        .filter((row) => members.has(row.makerId) && row.targetId === targetId)
        .map((row) => row.origin),
      ...graph.undiscoveredManualTargets
        .filter(
          (row) =>
            members.has(row.makerId) &&
            canonicalCharacterId(row.targetKey) ===
              canonicalCharacterId(targetKey)
        )
        .map((row) => row.origin)
    ];
    return {
      present: origins.length > 0,
      applicant:
        origins.length > 0 &&
        origins.every((origin) => origin === "applicant_sheet")
    };
  };
  const subject = (id: string): RankedSubject => {
    const character = graph.characters.get(id)!;
    const ownSource = graph.snapshotSources?.get(originId)?.get(id);
    const fallbackSource =
      ownSource ??
      [...(graph.snapshotSources?.values() ?? [])]
        .map((sources) => sources.get(id))
        .find((source) => source !== undefined);
    const strength = strengths.get(id);
    if (id !== originId && strength === undefined && ownSource === undefined)
      logger?.info({ event: "group_member_unreachable" });
    const pathSource =
      id === originId
        ? "input"
        : strength
          ? SOURCE_FOR[strength]
          : (fallbackSource ?? "fingerprint");
    if (
      id !== originId &&
      ownSource &&
      SOURCE_STRENGTH[ownSource] > SOURCE_STRENGTH[pathSource]
    )
      logger?.info({ event: "group_label_weakened" });
    // A committed publication remains authoritative while its group write heals.
    const source =
      id !== originId &&
      ownSource &&
      SOURCE_STRENGTH[ownSource] > SOURCE_STRENGTH[pathSource]
        ? ownSource
        : pathSource;
    const manual = manualFacts(character.key);
    return {
      key: character.key,
      displayName: character.displayName,
      className: character.className,
      guild: null,
      raiderIoUrl: character.raiderIoUrl,
      level: character.level,
      source,
      ...(manual.present ? { hasManualConnection: true } : {}),
      ...(source === "manually_added" && manual.applicant
        ? { origin: "application" as const }
        : {})
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
  // A page member's manual target with no character row yet, shaped as
  // today's read shapes a pending manual character: its key's name, no class
  // or guild, level 0 so it sorts last, and greyed when any maker on the
  // page excluded it.
  const undiscovered = new Map<string, RankedSubject>();
  const undiscoveredExcluded = new Set<string>();
  for (const row of graph.undiscoveredManualTargets) {
    if (!members.has(row.makerId) || graph.idOf(row.targetKey) !== undefined)
      continue;
    const canonical = canonicalCharacterId(row.targetKey);
    if (row.excluded) undiscoveredExcluded.add(canonical);
    if (undiscovered.has(canonical)) continue;
    undiscovered.set(canonical, {
      key: row.targetKey,
      displayName: row.targetKey.name,
      className: null,
      guild: null,
      raiderIoUrl: toRaiderIoUrl(row.targetKey),
      level: 0,
      source: "manually_added",
      hasManualConnection: true,
      ...(manualFacts(row.targetKey).applicant
        ? { origin: "application" as const }
        : {})
    });
  }
  const originCanonical = canonicalCharacterId(originKey);
  const ordered = [...[...members].map(subject), ...undiscovered.values()].sort(
    (left, right) => {
      const rootOrder =
        Number(canonicalCharacterId(right.key) === originCanonical) -
        Number(canonicalCharacterId(left.key) === originCanonical);
      return rootOrder || compareByLevelThenKey(left, right);
    }
  );
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
  const excludedSubject = (candidate: RankedSubject) => {
    const canonical = canonicalCharacterId(candidate.key);
    return (
      excludedIds.has(idByCanonical.get(canonical) ?? "") ||
      undiscoveredExcluded.has(canonical)
    );
  };
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
    const manual = [primary, ...aliases]
      .map((candidate) => manualFacts(candidate.key))
      .filter((fact) => fact.present);
    const primaryWithoutOrigin = { ...primary };
    delete primaryWithoutOrigin.origin;
    const row =
      aliases.length === 0
        ? primary
        : {
            ...primaryWithoutOrigin,
            ...(manual.length ? { hasManualConnection: true } : {}),
            ...(primary.source === "manually_added" &&
            manual.length &&
            manual.every((fact) => fact.applicant)
              ? { origin: "application" as const }
              : {}),
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
