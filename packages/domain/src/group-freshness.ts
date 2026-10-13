import { canonicalCharacterId } from "./deduplicate";
import type { CharacterKey } from "./character-key";
import { groupPageMembers, type GroupGraph } from "./character-connections";

export function groupMemberFacts<T extends { rootKey: CharacterKey }>(
  read: {
    graph: GroupGraph;
    runs: readonly T[];
    sweepStates: readonly GroupSweepState[];
  },
  key: CharacterKey
) {
  const originId = read.graph.idOf(key);
  const ids = originId
    ? groupPageMembers(originId, read.graph)
    : new Set<string>();
  const visible = (key: CharacterKey) => {
    const id = read.graph.idOf(key);
    return id !== undefined && ids.has(id);
  };
  return {
    ids,
    runs: read.runs.filter((run) => visible(run.rootKey)),
    sweepStates: read.sweepStates.filter((state) => visible(state.key))
  };
}

export function isFresh(
  completedAt: readonly Date[],
  at: Date,
  freshnessHours: number
): boolean {
  const cutoff = at.getTime() - freshnessHours * 3_600_000;
  return completedAt.some((time) => time.getTime() > cutoff);
}

export type GroupRunFact = Readonly<{
  status: string;
  completedAt: Date | null;
  createdAt: Date;
  rootKey?: CharacterKey;
}>;

export function hasFailureBackoff(
  runs: readonly GroupRunFact[],
  at: Date,
  freshnessHours: number,
  cadenceHours: number
): boolean {
  const byRoot = new Map<string, GroupRunFact[]>();
  for (const run of runs) {
    const key = run.rootKey ? canonicalCharacterId(run.rootKey) : "root";
    byRoot.set(key, [...(byRoot.get(key) ?? []), run]);
  }
  return [...byRoot.values()].some((history) => {
    history.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const latest = history[0];
    if (!latest || latest.status !== "failed" || !latest.completedAt)
      return false;
    let failures = 0;
    for (const run of history) {
      if (run.status !== "failed") break;
      failures++;
    }
    const hours = Math.min(
      cadenceHours,
      freshnessHours * 2 ** Math.min(failures - 1, 30)
    );
    return latest.completedAt.getTime() + hours * 3_600_000 > at.getTime();
  });
}

export type GroupSweepState = Readonly<{
  key: CharacterKey;
  lastPublishedAt: Date | null;
  resumeAfter: string | null;
  continuationFailures: number;
}>;

export function isSweepDue(
  states: readonly GroupSweepState[],
  runs: readonly GroupRunFact[],
  cadenceCutoff: Date,
  maxFailures: number
): boolean {
  return (
    !runs.some((run) =>
      ["queued", "running", "retrying"].includes(run.status)
    ) &&
    !states.some(
      (state) =>
        (state.lastPublishedAt !== null &&
          state.lastPublishedAt > cadenceCutoff) ||
        (state.resumeAfter !== null && state.continuationFailures < maxFailures)
    )
  );
}
