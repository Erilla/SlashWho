import type {
  CharacterGroupsAudit,
  CharacterGroupsLedgerRow
} from "@slashwho/database";
import {
  canonicalCharacterId,
  components,
  pathStrengths,
  type CharacterKey,
  type GroupGraph,
  type LinkStrength
} from "@slashwho/domain";
import type { RankedSubject, ResolvedSubjects } from "./dossier-subjects";
import {
  pageMembers,
  resolveGroupSubjects,
  type GroupSubjects
} from "./group-subjects";

/**
 * One thing the replay found. `detail` names characters by
 * `region/realm/name`, and a suppressed character only as "(suppressed)".
 */
export type ReplayFinding = Readonly<{ check: string; detail: string }>;

export type ReplayReport = Readonly<{
  failures: readonly ReplayFinding[];
  reports: readonly ReplayFinding[];
  counts: Readonly<Record<string, number>>;
  coverage: Readonly<Record<string, number>>;
  /** The newest backfill or rebuild row, where checks (a) to (d) start. */
  windowStart: string | null;
  /** Publications check (a) looked at: in the window, and settled. */
  publicationsChecked: number;
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
}>;

export type ReplayConfig = Readonly<{ DOSSIER_CHARACTER_CEILING: number }>;

type Resolve = (
  originKey: CharacterKey,
  graph: GroupGraph,
  config: ReplayConfig
) => GroupSubjects | null;

/** A publication younger than this may still have its write pending. */
const PENDING_MS = 10 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/**
 * The longest last-cycle length the bound believes. A cycle's length is
 * measured from its start to its completion, so a cycle that straddled a
 * worker outage measures the outage too; unclamped, that one reading would
 * stretch the bound far enough to hide the next stall. A cycle measured
 * longer than six hours is read as an outage rather than work, which caps
 * the bound at 1 h + 2 × 6 h = 13 h.
 */
const MAX_MEASURED_CYCLE_MS = 6 * HOUR_MS;

/**
 * How long drift may stay pending after what set it off, and how long the
 * maintenance may go without completing a cycle:
 * `max(2 h, 1 h + 2 × the last cycle's length)`, with that length clamped to
 * `MAX_MEASURED_CYCLE_MS`, or 2 h with no cycle measured.
 *
 * A trigger that lands just after a cycle started is only covered by the
 * next cycle to start. A pass stops at the first completed cycle that began
 * during it, so it completes at most two: the next pass, up to an hour
 * later, may have to finish the current cycle before it starts the covering
 * one, and then complete that. Past the bound, the backstop has missed.
 */
function pendingDriftBoundMs(
  maintenance: CharacterGroupsAudit["maintenance"]
): number {
  const { lastCycleStartedAt, lastCycleCompletedAt } = maintenance;
  if (lastCycleStartedAt === null || lastCycleCompletedAt === null)
    return 2 * HOUR_MS;
  const cycleMs = Math.min(
    MAX_MEASURED_CYCLE_MS,
    Math.max(0, lastCycleCompletedAt.getTime() - lastCycleStartedAt.getTime())
  );
  return Math.max(2 * HOUR_MS, HOUR_MS + 2 * cycleMs);
}

/** The sweep limitation a cycle that stopped at its cap publishes with. */
const CAPPED_SWEEP_LIMITATION = "fingerprint_sweep_capped";

/**
 * None of these times is a commit time. `recomputed_at`, `cycle_started_at`
 * and `created_at` are their transaction's start, `now()`, and a recompute
 * reads only once it holds its locks, later still. A writer stamps
 * `written_at` with the clock at its ledger insert, after its lock waits, so
 * the tolerance only has to cover the gap from that insert to the write's
 * commit: a write stamped this close before a recompute or a cycle start can
 * still commit after it, unseen, and is not taken as covered by it.
 */
const CLOCK_TOLERANCE_MS = 5 * 1000;

/** The ledger rows that re-seed every observer: nothing before them is owed. */
const BASELINE_REASONS: ReadonlySet<string> = new Set(["backfill", "rebuild"]);

/** Checks (a) to (d) start at the newest backfill or rebuild row. */
function windowStart(audit: CharacterGroupsAudit): number {
  return Math.max(
    0,
    ...audit.ledger
      .filter((row) => BASELINE_REASONS.has(row.reason))
      .map((row) => row.writtenAt.getTime())
  );
}

/** Observers with a publication so recent its write may still be pending. */
function youngObservers(audit: CharacterGroupsAudit): Set<string> {
  const cutoff = audit.now.getTime() - PENDING_MS;
  return new Set(
    audit.publications
      .filter((publication) => publication.at.getTime() > cutoff)
      .map((publication) => publication.observerId)
  );
}

const familyOfSource = (source: string): "raiderio" | "fingerprint" =>
  source === "fingerprint" ? "fingerprint" : "raiderio";

/**
 * Reconciles the observation writes against the ledger (#738):
 * - (a) completeness: every publication in the window has its ledger row;
 * - (b) presence: every latest-snapshot member has an observation from its
 *   root, in either family;
 * - (c) provenance: every observation's run has a ledger row for its
 *   observer and family;
 * - (d) retraction applied: nothing survives the newest `replaced` row that
 *   the writer would have retracted.
 *
 * Publications younger than 10 minutes are skipped by (a), and their roots
 * by (b). `coverage` counts the ledger's paths in the window.
 */
export function auditLedger(audit: CharacterGroupsAudit): {
  failures: ReplayFinding[];
  coverage: Record<string, number>;
  publicationsChecked: number;
} {
  const failures: ReplayFinding[] = [];
  const describe = describer(audit.graph);
  const start = windowStart(audit);
  const cutoff = audit.now.getTime() - PENDING_MS;
  const young = youngObservers(audit);

  // (a) completeness.
  const raiderIoRuns = new Set(
    audit.ledger
      .filter((row) => row.family === "raiderio")
      .map((row) => row.runId)
  );
  const fingerprintReservations = new Set(
    audit.ledger
      .filter((row) => row.family === "fingerprint")
      .flatMap((row) =>
        row.sweepReservationId === null ? [] : [row.sweepReservationId]
      )
  );
  let publicationsChecked = 0;
  for (const publication of audit.publications) {
    const at = publication.at.getTime();
    if (at <= start || at > cutoff) continue;
    publicationsChecked += 1;
    const owed =
      publication.kind === "run"
        ? raiderIoRuns.has(publication.runId)
        : fingerprintReservations.has(publication.reservationId);
    if (!owed) {
      failures.push({
        check: "a_completeness",
        detail: `${publication.kind} ${
          publication.kind === "run"
            ? publication.runId
            : publication.reservationId
        } for ${describe(publication.observerId)}`
      });
    }
  }

  // (b) presence, over raw membership: a suppressed member or root is still
  // checked, and never printed.
  const observedBy = new Set(
    audit.observations.flatMap((row) => [
      `${row.observerId}\0${row.lowId}`,
      `${row.observerId}\0${row.highId}`
    ])
  );
  for (const [rootId, members] of audit.latestRawMembership) {
    if (young.has(rootId)) continue;
    for (const memberId of members) {
      if (memberId === rootId) continue;
      if (!observedBy.has(`${rootId}\0${memberId}`)) {
        failures.push({
          check: "b_presence",
          detail: `${describe(memberId)} from ${describe(rootId)}`
        });
      }
    }
  }

  // (c) provenance.
  const logged = new Set(
    audit.ledger.map((row) => `${row.runId}\0${row.observerId}\0${row.family}`)
  );
  for (const row of audit.observations) {
    const family = familyOfSource(row.source);
    if (!logged.has(`${row.runId}\0${row.observerId}\0${family}`)) {
      failures.push({
        check: "c_provenance",
        detail: `${family} run ${row.runId} observed by ${describe(row.observerId)}`
      });
    }
  }

  // (d) retraction applied, against the newest `replaced` row per observer
  // and family, ordered by run start then write time. A later `added_only`
  // row does not make it vacuous.
  const byObserverFamily = new Map<string, CharacterGroupsLedgerRow[]>();
  for (const row of audit.ledger) {
    const compound = `${row.observerId}\0${row.family}`;
    byObserverFamily.set(compound, [
      ...(byObserverFamily.get(compound) ?? []),
      row
    ]);
  }
  for (const rows of byObserverFamily.values()) {
    const sorted = [...rows].sort(
      (left, right) =>
        left.runStartedAt.getTime() - right.runStartedAt.getTime() ||
        left.writtenAt.getTime() - right.writtenAt.getTime()
    );
    const replacedIndex = sorted
      .map((row) => row.decision)
      .lastIndexOf("replaced");
    const replaced = sorted[replacedIndex];
    if (!replaced) continue;
    const allowedRuns = new Set(
      sorted
        .slice(replacedIndex)
        .filter((row) => row.decision !== "blocked")
        .map((row) => row.runId)
    );
    for (const row of audit.observations) {
      if (
        row.observerId !== replaced.observerId ||
        familyOfSource(row.source) !== replaced.family
      )
        continue;
      // The writer never retracts a row observed after its own run started,
      // so such a row survives whichever run last saw it.
      if (row.observedAt.getTime() >= replaced.runStartedAt.getTime()) continue;
      if (!allowedRuns.has(row.runId)) {
        const other = row.lowId === row.observerId ? row.highId : row.lowId;
        failures.push({
          check: "d_retraction",
          detail: `${describe(other)} survives ${replaced.family} replacement for ${describe(row.observerId)}`
        });
      }
    }
  }

  return {
    failures,
    coverage: ledgerCoverage(audit, start),
    publicationsChecked
  };
}

/**
 * One count per ledger reason in the window, plus derived paths:
 * - the sweep publications by cycle: a run's first fingerprint row with a
 *   reservation is its first cycle, and every later one a continuation. A
 *   continuation whose reservation published without the capped limitation
 *   is the seal, whatever its ledger reason: a seal whose chain skipped a
 *   guild is logged `skipped_guild` and a blocked one `blocked_by_newer`,
 *   while a capped cycle can be logged `skipped_guild` too;
 * - `not_due_refresh`: a Raider.IO row, other than a baseline or a
 *   live-sweep completion, from a run with no fingerprint row, by an
 *   observer with an earlier fingerprint row. That is a run that published
 *   without sweeping because its root was swept recently;
 * - `manual_added`: the manual connections made in the window.
 */
function ledgerCoverage(
  audit: CharacterGroupsAudit,
  start: number
): Record<string, number> {
  const coverage: Record<string, number> = {};
  const add = (name: string) => {
    coverage[name] = (coverage[name] ?? 0) + 1;
  };
  const sealing = new Set(
    audit.publications.flatMap((publication) =>
      publication.kind === "reservation" &&
      publication.limitationCode !== CAPPED_SWEEP_LIMITATION
        ? [publication.reservationId]
        : []
    )
  );
  const fingerprintRuns = new Set(
    audit.ledger
      .filter((row) => row.family === "fingerprint")
      .map((row) => row.runId)
  );
  const firstFingerprintAt = new Map<string, number>();
  for (const row of audit.ledger) {
    if (row.family !== "fingerprint") continue;
    const at = row.writtenAt.getTime();
    firstFingerprintAt.set(
      row.observerId,
      Math.min(firstFingerprintAt.get(row.observerId) ?? at, at)
    );
  }
  const isNotDueRefresh = (row: CharacterGroupsLedgerRow) => {
    if (row.family !== "raiderio") return false;
    if (BASELINE_REASONS.has(row.reason)) return false;
    if (row.reason === "live_sweep_completion") return false;
    if (fingerprintRuns.has(row.runId)) return false;
    const swept = firstFingerprintAt.get(row.observerId);
    return swept !== undefined && swept < row.writtenAt.getTime();
  };
  const sweepRows = audit.ledger.filter(
    (row) =>
      row.family === "fingerprint" &&
      row.sweepReservationId !== null &&
      !BASELINE_REASONS.has(row.reason)
  );
  const isSweepRow = new Set(sweepRows);
  const firstCycle = new Map<string, CharacterGroupsLedgerRow>();
  for (const row of sweepRows) {
    const chain = `${row.runId}\0${row.observerId}`;
    const first = firstCycle.get(chain);
    if (!first || row.writtenAt.getTime() < first.writtenAt.getTime())
      firstCycle.set(chain, row);
  }
  for (const row of audit.ledger) {
    if (row.writtenAt.getTime() <= start) continue;
    add(row.reason);
    if (isNotDueRefresh(row)) add("not_due_refresh");
    if (!isSweepRow.has(row)) continue;
    add("sweep_publication");
    if (firstCycle.get(`${row.runId}\0${row.observerId}`) === row) {
      add("sweep_first_cycle");
      continue;
    }
    add("sweep_continuation");
    if (sealing.has(row.sweepReservationId!)) add("sweep_seal");
  }
  // A manual add writes no ledger row, so it is counted from its own table.
  for (const createdAt of audit.manualCreatedAt) {
    if (createdAt.getTime() > start) add("manual_added");
  }
  return coverage;
}

/**
 * Drift between the stored groups and the groups the links recompute to.
 * Each cluster of overlapping recomputed and stored groups is judged once:
 * - pending, and reported, while any stored group in it is pending (a
 *   member has a ledger write later than the group's recompute that no
 *   completed maintenance cycle started after), while any ungrouped
 *   character in it is newer than the last completed cycle's start, or
 *   while a manual link joins it across stored groups and a manual change
 *   is newer than that start. A write within 5 s before a recompute or a
 *   cycle start is not covered by it;
 * - failed as stale pending once what set a pending arm off is older than
 *   the bound (`pendingDriftBoundMs`). A group's clock runs from its
 *   earliest uncovered write, and the manual arm's from the earliest
 *   uncovered manual change, so a group written every hour still goes
 *   stale;
 * - reported, when the stored group is coarser than the recomputed ones and
 *   no member of one recomputed part was ever observed by a member of
 *   another, in any published snapshot. That is how a removed manual row,
 *   which leaves no trace, shows. A retraction also deletes its row, so the
 *   current links cannot tell the two apart; the snapshots can;
 * - failed otherwise.
 */
export function auditDrift(audit: CharacterGroupsAudit): {
  failures: ReplayFinding[];
  reports: ReplayFinding[];
} {
  const failures: ReplayFinding[] = [];
  const reports: ReplayFinding[] = [];
  const describe = describer(audit.graph);
  const { groupOf } = audit.graph;
  const parts = components(audit.graph.characters.keys(), audit.graph.links);
  const partOf = new Map<string, number>();
  parts.forEach((members, index) => {
    for (const id of members) partOf.set(id, index);
  });

  // Join recomputed parts that share a stored group.
  const parent = parts.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    parent[index] = root;
    return root;
  };
  const firstPartOfGroup = new Map<string, number>();
  for (const [id, groupId] of groupOf) {
    const part = partOf.get(id);
    if (part === undefined) continue;
    const first = firstPartOfGroup.get(groupId);
    if (first === undefined) firstPartOfGroup.set(groupId, part);
    else parent[find(part)] = find(first);
  }
  const clusters = new Map<number, number[]>();
  parts.forEach((_, index) => {
    const root = find(index);
    clusters.set(root, [...(clusters.get(root) ?? []), index]);
  });

  const cycleCoveredAfter = (at: number) => {
    const { lastCycleStartedAt, lastCycleCompletedAt } = audit.maintenance;
    return (
      lastCycleStartedAt !== null &&
      lastCycleCompletedAt !== null &&
      at <= lastCycleStartedAt.getTime() - CLOCK_TOLERANCE_MS &&
      lastCycleCompletedAt.getTime() >= lastCycleStartedAt.getTime()
    );
  };
  const writesBy = new Map<string, number[]>();
  for (const row of audit.ledger) {
    writesBy.set(row.observerId, [
      ...(writesBy.get(row.observerId) ?? []),
      row.writtenAt.getTime()
    ]);
  }
  /** The earliest uncovered time of those given, or null when all are covered. */
  const earliestUncovered = (times: readonly number[]): number | null => {
    const uncovered = times.filter((at) => !cycleCoveredAfter(at));
    return uncovered.length === 0 ? null : Math.min(...uncovered);
  };
  /**
   * The earliest write a stored group is pending on, or null when it is
   * settled: a member's write later than the recompute that no completed
   * cycle covers.
   */
  const groupPendingSince = (groupId: string): number | null => {
    const group = audit.groups.get(groupId);
    // A member row with no group row cannot happen under one consistent
    // read. Were it to, it has been pending for ever, and fails as stale.
    if (!group) return 0;
    const recomputedAt = group.recomputedAt.getTime() - CLOCK_TOLERANCE_MS;
    return earliestUncovered(
      group.members.flatMap((id) =>
        (writesBy.get(id) ?? []).filter((at) => at > recomputedAt)
      )
    );
  };
  const manualPendingSince = earliestUncovered(
    audit.manualChanges.map((at) => at.getTime())
  );
  const boundMs = pendingDriftBoundMs(audit.maintenance);
  const staleBefore = audit.now.getTime() - boundMs;
  const storedGroupOf = (id: string) => groupOf.get(id) ?? `ungrouped\0${id}`;

  for (const indices of clusters.values()) {
    const ids = indices.flatMap((index) => parts[index]!).sort();
    const idSet = new Set(ids);
    const groupIds = [...new Set(ids.flatMap((id) => groupOf.get(id) ?? []))];
    const ungrouped = ids.filter((id) => !groupOf.has(id));
    if (indices.length === 1 && groupIds.length === 1 && ungrouped.length === 0)
      continue;
    const around = describe(ids[0]!);

    const manualAcross = audit.graph.links.some(
      (link) =>
        link.strength === "manual" &&
        idSet.has(link.a) &&
        idSet.has(link.b) &&
        storedGroupOf(link.a) !== storedGroupOf(link.b)
    );
    // What set each pending arm off: a group's earliest uncovered write, an
    // ungrouped character's creation, or the earliest uncovered manual
    // change.
    const triggers = [
      ...groupIds.flatMap((id) => groupPendingSince(id) ?? []),
      ...ungrouped.flatMap((id) => {
        // Every ungrouped character has its creation loaded; a missing one
        // counts as created long ago, so it can never wait unbounded.
        const created = audit.ungroupedSince.get(id)?.getTime() ?? 0;
        return cycleCoveredAfter(created) ? [] : [created];
      }),
      ...(manualAcross && manualPendingSince !== null
        ? [manualPendingSince]
        : [])
    ];
    if (triggers.length > 0) {
      if (triggers.some((at) => at < staleBefore)) {
        failures.push({
          check: "drift_stale_pending",
          detail: `${ids.length} characters around ${around}, pending over ${Math.round(boundMs / 60_000)} minutes`
        });
      } else {
        reports.push({
          check: "drift_pending",
          detail: `${ids.length} characters around ${around}`
        });
      }
      continue;
    }

    const coarserOnly = groupIds.length === 1 && ungrouped.length === 0;
    // Judged from the immutable snapshots, not the links: a retraction and a
    // manual removal both delete a row, and only a pair never observed can
    // have been joined by a manual row alone.
    const observedAcross =
      ids.some((from) =>
        [...(audit.observedEver.get(from) ?? [])].some(
          (to) => idSet.has(to) && partOf.get(from) !== partOf.get(to)
        )
      ) ||
      audit.observations.some(
        (row) =>
          idSet.has(row.lowId) &&
          idSet.has(row.highId) &&
          partOf.get(row.lowId) !== partOf.get(row.highId)
      );
    if (coarserOnly && !observedAcross) {
      reports.push({
        check: "drift_manual",
        detail: `${indices.length} recomputed groups in one stored group around ${around}`
      });
      continue;
    }
    failures.push({
      check: "drift",
      detail: `${indices.length} recomputed and ${groupIds.length + ungrouped.length} stored groups around ${around}`
    });
  }
  return { failures, reports };
}

const LABEL_RANK = {
  raiderio_declared: 3,
  fingerprint_derived: 2,
  manually_added: 1
} as const;
type Label = keyof typeof LABEL_RANK;

/** The label a dossier row is serialised with; null for an applicant's own row. */
function labelOf(source: RankedSubject["source"]): Label | null {
  if (source === "submitted") return null;
  if (source === "manually_added") return "manually_added";
  if (source === "fingerprint") return "fingerprint_derived";
  return "raiderio_declared";
}

const LABEL_OF_STRENGTH: Record<LinkStrength, Label> = {
  raiderio: "raiderio_declared",
  fingerprint: "fingerprint_derived",
  manual: "manually_added"
};

type PageRow = Readonly<{ subject: RankedSubject; excluded: boolean }>;

const keysOf = (subject: RankedSubject): CharacterKey[] => [
  subject.key,
  ...(subject.warcraftLogsAliases ?? [])
];

/**
 * The graph with each character's group recomputed from the links, so the
 * pages test the read logic whatever state the stored groups are in.
 */
function withRecomputedGroups(graph: GroupGraph): GroupGraph {
  const groupOf = new Map<string, string>();
  for (const members of components(graph.characters.keys(), graph.links)) {
    for (const id of members) groupOf.set(id, members[0]!);
  }
  return { ...graph, groupOf };
}

/**
 * Today's dossier pages against phase 2's resolution over the recomputed
 * groups, page by page. Identities are compared as sets of keys (a row's key
 * and its Warcraft Logs aliases), never by which key leads the row.
 * - Fails on a removed character, a weakened label, an exclusion no row in
 *   the group explains, an exclusion today's page applies and the group
 *   page drops, a missing limitation code no shared exclusion explains, and
 *   a page over the ceiling.
 * - Reports growth, research state changes, shared exclusions and the
 *   limitations they remove.
 * - Skips a page any of whose characters published under 10 minutes ago.
 * - Skips, and reports as `page_moved`, a page resolved from a snapshot other
 *   than the latest the audit read.
 *
 * `resolve` is the phase 2 resolution; tests replace it.
 */
export function comparePages(
  audit: CharacterGroupsAudit,
  legacy: ReadonlyMap<string, ResolvedSubjects | null>,
  config: ReplayConfig,
  resolve: Resolve = resolveGroupSubjects
): {
  failures: ReplayFinding[];
  reports: ReplayFinding[];
  counts: Record<string, number>;
} {
  const failures: ReplayFinding[] = [];
  const reports: ReplayFinding[] = [];
  const graph = withRecomputedGroups(audit.graph);
  const describeKey = keyDescriber(graph);
  const young = youngObservers(audit);
  const exclusionRows = [
    ...graph.manual.filter((row) => row.excluded),
    ...graph.discoveredExclusions
  ];
  const isSelfExclusion = (row: { makerId: string; targetId: string }) =>
    graph.sharedIdentity(row.makerId).has(row.targetId);
  const counts: Record<string, number> = {
    pages: 0,
    pendingPages: 0,
    movedPages: 0,
    provisional: 0,
    unchanged: 0,
    grew: 0,
    lost: 0,
    researchStateChanged: 0,
    sharedExclusions: 0,
    selfExclusions: exclusionRows.filter(isSelfExclusion).length
  };
  const bump = (name: string, by = 1) => {
    counts[name] = (counts[name] ?? 0) + by;
  };

  for (const key of audit.roots) {
    const today = legacy.get(canonicalCharacterId(key)) ?? null;
    if (!today) continue;
    const originId = graph.idOf(key);
    const todayRows: PageRow[] = [
      ...[...today.selected, ...today.skipped].map((subject) => ({
        subject,
        excluded: false
      })),
      ...today.excludedOrdered.map((subject) => ({ subject, excluded: true }))
    ];
    const pageIds = [
      ...(originId === undefined ? [] : [originId]),
      ...todayRows.flatMap((row) =>
        keysOf(row.subject).flatMap((candidate) => graph.idOf(candidate) ?? [])
      )
    ];
    if (pageIds.some((id) => young.has(id))) {
      bump("pendingPages");
      continue;
    }
    const page = describeKey(key);
    // Today's page was resolved after the audit's read. One built from a
    // snapshot published in between is not comparable with the audit's
    // groups, and would show its changes as removals.
    if (!audit.latestSnapshotIds.has(today.snapshot.id)) {
      bump("movedPages");
      reports.push({ check: "page_moved", detail: page });
      continue;
    }
    bump("pages");
    if (today.provisional) bump("provisional");
    const next = originId === undefined ? null : resolve(key, graph, config);
    if (!next || originId === undefined) {
      failures.push({ check: "page_missing", detail: page });
      continue;
    }
    const nextRows: PageRow[] = [
      ...[...next.selected, ...next.skipped].map((subject) => ({
        subject,
        excluded: false
      })),
      ...next.excluded.map((subject) => ({ subject, excluded: true }))
    ];
    const nextByKey = new Map<string, PageRow>();
    for (const row of nextRows) {
      for (const candidate of keysOf(row.subject))
        nextByKey.set(canonicalCharacterId(candidate), row);
    }
    const originCanonical = canonicalCharacterId(key);
    const holdsOrigin = (row: PageRow) =>
      keysOf(row.subject).some(
        (candidate) => canonicalCharacterId(candidate) === originCanonical
      );

    // Members: every key today shows, the group page must show too, an
    // undiscovered manual target included.
    const todayKeys = new Set<string>();
    for (const row of todayRows) {
      for (const candidate of keysOf(row.subject)) {
        const canonical = canonicalCharacterId(candidate);
        todayKeys.add(canonical);
        if (!nextByKey.has(canonical)) {
          failures.push({
            check: "removed",
            detail: `${describeKey(candidate)} from ${page}`
          });
        }
      }
    }

    // Labels, the opened character's own row aside. Where the two reads
    // lead an identity with different keys, today's key is compared with
    // the label its own path earns.
    let strengths: Map<string, LinkStrength> | null = null;
    const strengthOf = (id: string | undefined) => {
      if (id === undefined) return undefined;
      if (strengths === null) {
        const members = pageMembers(originId, graph);
        strengths = pathStrengths(
          originId,
          graph.links.filter(
            (link) => members.has(link.a) && members.has(link.b)
          )
        );
      }
      return strengths.get(id);
    };
    for (const row of todayRows) {
      if (holdsOrigin(row)) continue;
      const found = nextByKey.get(canonicalCharacterId(row.subject.key));
      if (!found) continue;
      const before = labelOf(row.subject.source);
      if (before === null) continue;
      let after: Label | null;
      if (
        canonicalCharacterId(found.subject.key) ===
        canonicalCharacterId(row.subject.key)
      ) {
        after = labelOf(found.subject.source);
      } else {
        const strength = strengthOf(graph.idOf(row.subject.key));
        after = strength === undefined ? null : LABEL_OF_STRENGTH[strength];
      }
      if (after !== null && LABEL_RANK[after] < LABEL_RANK[before]) {
        failures.push({
          check: "label_weakened",
          detail: `${describeKey(row.subject.key)} on ${page}`
        });
      }
    }

    // Excluded state, following Warcraft Logs aliases: a row is excluded
    // when any of its keys is named.
    const originGroup = graph.groupOf.get(originId);
    const todayExcluded = new Set(
      todayRows
        .filter((row) => row.excluded)
        .flatMap((row) => keysOf(row.subject).map(canonicalCharacterId))
    );
    let shared = 0;
    for (const row of nextRows) {
      if (!row.excluded) continue;
      const ids = new Set(
        keysOf(row.subject).flatMap((candidate) => graph.idOf(candidate) ?? [])
      );
      const canonicals = new Set(keysOf(row.subject).map(canonicalCharacterId));
      const explained =
        exclusionRows.some(
          (exclusion) =>
            ids.has(exclusion.targetId) &&
            graph.groupOf.get(exclusion.makerId) === originGroup &&
            !isSelfExclusion(exclusion)
        ) ||
        graph.undiscoveredManualTargets.some(
          (target) =>
            target.excluded &&
            canonicals.has(canonicalCharacterId(target.targetKey)) &&
            graph.groupOf.get(target.makerId) === originGroup
        );
      if (!explained) {
        failures.push({
          check: "exclusion_unexplained",
          detail: `${describeKey(row.subject.key)} on ${page}`
        });
      } else if (
        !keysOf(row.subject).some((candidate) =>
          todayExcluded.has(canonicalCharacterId(candidate))
        )
      ) {
        shared += 1;
        reports.push({
          check: "shared_exclusion",
          detail: `${describeKey(row.subject.key)} on ${page}`
        });
      }
    }
    bump("sharedExclusions", shared);
    for (const row of todayRows) {
      if (!row.excluded) continue;
      const found = keysOf(row.subject)
        .map((candidate) => nextByKey.get(canonicalCharacterId(candidate)))
        .find((candidate) => candidate !== undefined);
      if (found && !found.excluded && !holdsOrigin(found)) {
        failures.push({
          check: "exclusion_lost",
          detail: `${describeKey(row.subject.key)} on ${page}`
        });
      }
    }

    // Limitation codes and research state.
    const code = today.snapshot.limitationCode;
    if (code && !next.research.limitationCodes.includes(code)) {
      if (shared > 0) {
        reports.push({
          check: "limitation_removed",
          detail: `${code} on ${page}`
        });
      } else {
        failures.push({
          check: "limitation_missing",
          detail: `${code} on ${page}`
        });
      }
    }
    // A provisional page's snapshot is borrowed from another root, and
    // today's read exposes no assembled state for the page itself, so its
    // state is not comparable.
    if (!today.provisional && today.snapshot.state !== next.research.state) {
      bump("researchStateChanged");
      reports.push({
        check: "research_state_changed",
        detail: `${today.snapshot.state} to ${next.research.state} on ${page}`
      });
    }

    if (next.skipped.length > 0) {
      failures.push({ check: "over_ceiling", detail: page });
    }

    const nextKeys = new Set(nextByKey.keys());
    const extra = [...nextKeys].filter((id) => !todayKeys.has(id)).length;
    if (extra > 0) {
      bump("grew");
      reports.push({ check: "grew", detail: `${extra} more on ${page}` });
    } else if ([...todayKeys].some((id) => !nextKeys.has(id))) {
      bump("lost");
    } else {
      bump("unchanged");
    }
  }
  return { failures, reports, counts };
}

/**
 * Fails `maintenance_stale` when no maintenance cycle has completed within
 * the bound, measured from the later of the window start and the last
 * completed cycle. With no cycle, drift is never judged, so the replay would
 * otherwise pass however stuck the maintenance is. With no baseline row the
 * writer's first ledger write stands in for the window start.
 */
export function auditMaintenance(audit: CharacterGroupsAudit): {
  failures: ReplayFinding[];
} {
  const baseline = windowStart(audit);
  const firstWrite = audit.ledger.reduce<number | null>(
    (earliest, row) =>
      earliest === null
        ? row.writtenAt.getTime()
        : Math.min(earliest, row.writtenAt.getTime()),
    null
  );
  const since = Math.max(
    baseline > 0 ? baseline : (firstWrite ?? 0),
    audit.maintenance.lastCycleCompletedAt?.getTime() ?? 0
  );
  const boundMs = pendingDriftBoundMs(audit.maintenance);
  return audit.now.getTime() - since > boundMs
    ? {
        failures: [
          {
            check: "maintenance_stale",
            detail: `no maintenance cycle completed in the last ${Math.round(boundMs / 60_000)} minutes`
          }
        ]
      }
    : { failures: [] };
}

const isoOrNull = (at: Date | null) => (at === null ? null : at.toISOString());

/** The whole replay: the pages, the ledger checks, drift and maintenance. */
export function replayCharacterGroups(
  audit: CharacterGroupsAudit,
  legacy: ReadonlyMap<string, ResolvedSubjects | null>,
  config: ReplayConfig
): ReplayReport {
  const ledger = auditLedger(audit);
  const drift = auditDrift(audit);
  const maintenance = auditMaintenance(audit);
  const pages = comparePages(audit, legacy, config);
  const start = windowStart(audit);
  return {
    failures: [
      ...pages.failures,
      ...ledger.failures,
      ...drift.failures,
      ...maintenance.failures
    ],
    reports: [...pages.reports, ...drift.reports],
    counts: pages.counts,
    coverage: ledger.coverage,
    windowStart: start > 0 ? new Date(start).toISOString() : null,
    publicationsChecked: ledger.publicationsChecked,
    lastCycleStartedAt: isoOrNull(audit.maintenance.lastCycleStartedAt),
    lastCycleCompletedAt: isoOrNull(audit.maintenance.lastCycleCompletedAt)
  };
}

function formatKey(key: CharacterKey): string {
  return `${key.region}/${key.realm}/${key.name}`;
}

/** Names a character by id, and a suppressed one only as "(suppressed)". */
function describer(graph: GroupGraph): (id: string) => string {
  return (id) => {
    if (graph.suppressed.has(id)) return "(suppressed)";
    const character = graph.characters.get(id);
    return character ? formatKey(character.key) : "(unknown)";
  };
}

/** Names a character by key, and a suppressed one only as "(suppressed)". */
function keyDescriber(graph: GroupGraph): (key: CharacterKey) => string {
  return (key) => {
    const id = graph.idOf(key);
    return id !== undefined && graph.suppressed.has(id)
      ? "(suppressed)"
      : formatKey(key);
  };
}
