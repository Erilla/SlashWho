import type { CharacterKey } from "./character-key";
import type { DiscoverySource } from "./deduplicate";

/**
 * The two source families retraction is decided by (#738). A run can finish
 * one family's discovery and not the other's, so each is decided alone.
 */
export type ConnectionFamily = "raiderio" | "fingerprint";

/** A discovery source that names a link: every source but the root's own. */
export type ObservationSource = Exclude<DiscoverySource, "input">;

/**
 * The codes the character connections repository throws as its message.
 * Each is a fixed string, so it is safe to log.
 */
export const CHARACTER_CONNECTION_ERROR_CODES = [
  "character_connections_run_missing",
  "character_connections_run_root_mismatch",
  "character_connections_observer_missing",
  "character_connections_family_mismatch"
] as const;

export type CharacterConnectionErrorCode =
  (typeof CHARACTER_CONNECTION_ERROR_CODES)[number];

const knownErrorCodes: ReadonlySet<string> = new Set(
  CHARACTER_CONNECTION_ERROR_CODES
);

/**
 * What a character groups failure may log as `errorCode`: the pg SQLSTATE
 * (55P03 is a lock timeout), else one of the repository's own codes, else
 * nothing. Never the message itself, which could carry user data.
 */
export function characterGroupsErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  if (knownErrorCodes.has(error.message)) return error.message;
  return undefined;
}

export type LedgerDecision = "added_only" | "replaced" | "blocked";

export type LedgerReason =
  | "raiderio_complete"
  | "raiderio_limited"
  | "privacy_hidden"
  | "capped"
  | "matched"
  | "unread"
  | "skipped_guild"
  | "live_sweep_completion"
  | "blocked_by_newer"
  | "backfill"
  | "rebuild";

export type FamilyDecision = Readonly<{
  decision: "added_only" | "replaced";
  reason: LedgerReason;
}>;

export function familyOf(source: ObservationSource): ConnectionFamily {
  return source === "fingerprint" ? "fingerprint" : "raiderio";
}

/**
 * Whether a run's own Raider.IO discovery may retract the observer's earlier
 * Raider.IO links. Only a discovery with no limitation proves an absence.
 */
export function raiderIoDecision(
  limitationCode: string | null
): FamilyDecision {
  if (limitationCode === null)
    return { decision: "replaced", reason: "raiderio_complete" };
  if (limitationCode === "privacy_hidden")
    return { decision: "added_only", reason: "privacy_hidden" };
  return { decision: "added_only", reason: "raiderio_limited" };
}

export type SweepFacts = Readonly<{
  kind: "matched" | "capped";
  unreadRoot: boolean;
  skippedHistoricalGuilds: number;
}>;

/**
 * Whether a sweep may retract the observer's earlier fingerprint links: only
 * a match that read every roster it set out to. A skipped guild wins over
 * `capped`, so a chain's seal can find the skip in the ledger and not retract.
 */
export function fingerprintDecision(sweep: SweepFacts): FamilyDecision {
  if (sweep.skippedHistoricalGuilds > 0)
    return { decision: "added_only", reason: "skipped_guild" };
  if (sweep.kind === "capped")
    return { decision: "added_only", reason: "capped" };
  if (sweep.unreadRoot) return { decision: "added_only", reason: "unread" };
  return { decision: "replaced", reason: "matched" };
}

export type Link = Readonly<{ a: string; b: string }>;

/** Connected components by reach. Each is sorted; the list is sorted by first id. */
export function components(
  nodes: Iterable<string>,
  links: readonly Link[]
): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) {
      const next = parent.get(root);
      if (next === undefined) break;
      root = next;
    }
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor);
      if (next === undefined) break;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const ensure = (id: string) => {
    if (!parent.has(id)) parent.set(id, id);
  };
  for (const node of nodes) ensure(node);
  for (const link of links) {
    ensure(link.a);
    ensure(link.b);
    const left = find(link.a);
    const right = find(link.b);
    if (left !== right)
      parent.set(left < right ? right : left, left < right ? left : right);
  }
  const byRoot = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    byRoot.set(root, [...(byRoot.get(root) ?? []), id]);
  }
  return [...byRoot.values()]
    .map((members) => [...members].sort())
    .sort((left, right) => {
      const leftHead = left[0];
      const rightHead = right[0];
      if (leftHead === undefined || rightHead === undefined) return 0;
      return leftHead < rightHead ? -1 : 1;
    });
}

export type ExistingGroup = Readonly<{ id: string; createdAt: Date }>;

/** A recomputed component, and the group id it keeps; null means a new group. */
export type GroupAssignment = Readonly<{
  groupId: string | null;
  members: readonly string[];
}>;

/**
 * Which group each recomputed component keeps.
 * - A component may keep an old group only if it is that group's heir: the
 *   part holding most of its members, with ties going to the part holding
 *   its lowest member id.
 * - A component that is heir to several groups keeps the oldest; the rest
 *   are deleted.
 */
export function assignGroupIds(
  parts: readonly (readonly string[])[],
  membership: ReadonlyMap<string, string>,
  groups: ReadonlyMap<string, ExistingGroup>
): { assignments: GroupAssignment[]; deletedGroupIds: string[] } {
  const sorted = parts.map((members) => [...members].sort());
  const heirOf = new Map<string, number>();
  for (const groupId of new Set(
    sorted.flat().flatMap((id) => membership.get(id) ?? [])
  )) {
    let best = -1;
    let bestCount = -1;
    let bestLowest = "";
    sorted.forEach((members, index) => {
      const held = members.filter((id) => membership.get(id) === groupId);
      if (held.length === 0) return;
      const lowest = held[0];
      if (lowest === undefined) return;
      if (
        held.length > bestCount ||
        (held.length === bestCount && lowest < bestLowest)
      ) {
        best = index;
        bestCount = held.length;
        bestLowest = lowest;
      }
    });
    heirOf.set(groupId, best);
  }
  const kept = new Set<string>();
  const assignments = sorted.map((members, index) => {
    const candidates = [...heirOf.entries()]
      .filter(([, heir]) => heir === index)
      .map(([groupId]) => groups.get(groupId))
      .filter((group): group is ExistingGroup => group !== undefined)
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          (left.id < right.id ? -1 : 1)
      );
    const keep = candidates[0]?.id ?? null;
    if (keep) kept.add(keep);
    return { groupId: keep, members };
  });
  const deletedGroupIds = [...heirOf.keys()]
    .filter((groupId) => !kept.has(groupId))
    .sort();
  return { assignments, deletedGroupIds };
}

export type LinkStrength = "raiderio" | "fingerprint" | "manual";
export type StrengthLink = Readonly<{
  a: string;
  b: string;
  strength: LinkStrength;
}>;

/**
 * A character group's full read model for phase 2's dossier resolution
 * (#738). Defined here, rather than in `application`, because Task 10's
 * loader lives in the database package, which cannot import from
 * `application` (application depends on database).
 */
export type GroupGraph = Readonly<{
  characters: ReadonlyMap<
    string,
    Readonly<{
      key: CharacterKey;
      displayName: string;
      className: string;
      level: number;
      raiderIoUrl: string;
    }>
  >;
  idOf: (key: CharacterKey) => string | undefined;
  groupOf: ReadonlyMap<string, string>; // character id → group id
  links: readonly Readonly<{ a: string; b: string; strength: LinkStrength }>[]; // counting links, manual included
  manual: readonly Readonly<{
    makerId: string;
    targetId: string;
    excluded: boolean;
  }>[];
  /**
   * Manual targets with no `characters` row yet, so not in `characters` or
   * `manual`. Today's read lists each as a pending manual character, so the
   * group read must too. Suppressed targets are left out.
   */
  undiscoveredManualTargets: readonly Readonly<{
    makerId: string;
    targetKey: CharacterKey;
    excluded: boolean;
  }>[];
  discoveredExclusions: readonly Readonly<{
    makerId: string;
    targetId: string;
  }>[];
  suppressed: ReadonlySet<string>; // character ids
  warcraftLogsIds: ReadonlyMap<string, number>; // character id → WCL id
  sharedIdentity: (id: string) => ReadonlySet<string>; // ids sharing a WCL id, self included
  latestSnapshot: ReadonlyMap<
    string,
    Readonly<{ state: "complete" | "partial"; limitationCode: string | null }>
  >; // by root id, suppression-filtered
}>;

/**
 * Each reachable node's label strength seen from `origin` (#738).
 * - A node's strength is decided over simple paths (no vertex repeated) from
 *   `origin`, never over walks that double back through a node already on
 *   the path:
 *   - "raiderio": some simple path using only `raiderio` and `manual` links
 *     contains at least one `raiderio` link;
 *   - otherwise "fingerprint": some simple path over all links contains at
 *     least one provider link (`raiderio` or `fingerprint`);
 *   - otherwise "manual": the node is reachable only through manual links.
 * - A node absent from the origin's reach (in the full link graph) is
 *   absent from the result; `origin` itself is never a key.
 *
 * Computed exactly via biconnected components (see `hasProviderPathFrom`),
 * run once per rule above, rather than by a walk over (node, value) states:
 * that would let a walk leave a node and double back through it, crediting
 * it with a stronger label than any real simple path to it carries.
 */
export function pathStrengths(
  origin: string,
  links: readonly StrengthLink[]
): Map<string, LinkStrength> {
  const allEdges: ConnectionEdge[] = [];
  const manualOrRaiderioEdges: ConnectionEdge[] = [];
  const raiderioEdgeIds = new Set<number>();
  const nonManualEdgeIds = new Set<number>();
  links.forEach((link, id) => {
    const edge: ConnectionEdge = { id, a: link.a, b: link.b };
    allEdges.push(edge);
    if (link.strength !== "fingerprint") manualOrRaiderioEdges.push(edge);
    if (link.strength === "raiderio") raiderioEdgeIds.add(id);
    if (link.strength !== "manual") nonManualEdgeIds.add(id);
  });

  const raiderioRun = hasProviderPathFrom(
    origin,
    manualOrRaiderioEdges,
    raiderioEdgeIds
  );
  const fingerprintRun = hasProviderPathFrom(
    origin,
    allEdges,
    nonManualEdgeIds
  );

  const result = new Map<string, LinkStrength>();
  for (const node of fingerprintRun.keys()) {
    result.set(
      node,
      raiderioRun.get(node)
        ? "raiderio"
        : fingerprintRun.get(node)
          ? "fingerprint"
          : "manual"
    );
  }
  return result;
}

type ConnectionEdge = Readonly<{ id: number; a: string; b: string }>;
type ConnectionBlock = Readonly<{
  edgeIds: readonly number[];
  vertices: ReadonlySet<string>;
}>;

function buildAdjacency(
  edges: readonly ConnectionEdge[]
): Map<string, { to: string; edgeId: number }[]> {
  const adjacency = new Map<string, { to: string; edgeId: number }[]>();
  for (const edge of edges) {
    adjacency.set(edge.a, [
      ...(adjacency.get(edge.a) ?? []),
      { to: edge.b, edgeId: edge.id }
    ]);
    adjacency.set(edge.b, [
      ...(adjacency.get(edge.b) ?? []),
      { to: edge.a, edgeId: edge.id }
    ]);
  }
  return adjacency;
}

/**
 * The biconnected components (blocks) of `start`'s connected component, via
 * Tarjan's edge-stack algorithm. Each block is a maximal edge set any two
 * of which lie on a common simple cycle; a bridge is its own block of one
 * edge. A vertex shared by two or more blocks is a cut vertex: every simple
 * path between vertices of different blocks passes through it. Parallel
 * edges between the same pair of vertices get their own ids, so each is
 * tracked (and can be selected) independently of the other.
 */
function biconnectedComponents(
  adjacency: ReadonlyMap<string, { to: string; edgeId: number }[]>,
  start: string
): ConnectionBlock[] {
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const edgeStack: ConnectionEdge[] = [];
  const blocks: ConnectionBlock[] = [];
  let counter = 0;

  const popBlockThrough = (edgeId: number): void => {
    const edgeIds: number[] = [];
    const vertices = new Set<string>();
    for (;;) {
      const top = edgeStack.pop();
      if (top === undefined) break;
      edgeIds.push(top.id);
      vertices.add(top.a);
      vertices.add(top.b);
      if (top.id === edgeId) break;
    }
    blocks.push({ edgeIds, vertices });
  };

  const dfs = (node: string, parentEdgeId: number | null): void => {
    disc.set(node, counter);
    low.set(node, counter);
    counter += 1;
    for (const { to, edgeId } of adjacency.get(node) ?? []) {
      if (edgeId === parentEdgeId) continue;
      if (!disc.has(to)) {
        edgeStack.push({ id: edgeId, a: node, b: to });
        dfs(to, edgeId);
        low.set(node, Math.min(low.get(node)!, low.get(to)!));
        if (low.get(to)! >= disc.get(node)!) popBlockThrough(edgeId);
      } else if (disc.get(to)! < disc.get(node)!) {
        edgeStack.push({ id: edgeId, a: node, b: to });
        low.set(node, Math.min(low.get(node)!, disc.get(to)!));
      }
    }
  };

  dfs(start, null);
  return blocks;
}

type TreeNode =
  | Readonly<{ kind: "block"; index: number }>
  | Readonly<{ kind: "vertex"; id: string }>;

/** A key unique across both tree-node kinds, whatever the vertex ids are. */
const treeNodeKey = (node: TreeNode): string =>
  node.kind === "block" ? `block\0${node.index}` : `vertex\0${node.id}`;

/**
 * The block-cut tree of `blocks`: a node per block and a node per cut
 * vertex (a vertex shared by 2+ blocks), a cut vertex joined to every block
 * containing it.
 */
function buildBlockCutTree(blocks: readonly ConnectionBlock[]): {
  neighboursOf: ReadonlyMap<string, readonly TreeNode[]>;
  isCutVertex: (vertex: string) => boolean;
} {
  const blockCountByVertex = new Map<string, number>();
  for (const block of blocks) {
    for (const vertex of block.vertices) {
      blockCountByVertex.set(vertex, (blockCountByVertex.get(vertex) ?? 0) + 1);
    }
  }
  const isCutVertex = (vertex: string): boolean =>
    (blockCountByVertex.get(vertex) ?? 0) >= 2;

  const neighboursOf = new Map<string, TreeNode[]>();
  const link = (left: TreeNode, right: TreeNode): void => {
    const leftKey = treeNodeKey(left);
    const rightKey = treeNodeKey(right);
    neighboursOf.set(leftKey, [...(neighboursOf.get(leftKey) ?? []), right]);
    neighboursOf.set(rightKey, [...(neighboursOf.get(rightKey) ?? []), left]);
  };
  blocks.forEach((block, index) => {
    const blockNode: TreeNode = { kind: "block", index };
    for (const vertex of block.vertices) {
      if (isCutVertex(vertex)) link(blockNode, { kind: "vertex", id: vertex });
    }
  });
  return { neighboursOf, isCutVertex };
}

/**
 * For every vertex reachable from `origin` within the subgraph induced by
 * `edges` (excluding `origin` itself): whether some simple `origin`-to-node
 * path in that subgraph contains at least one edge whose id is in
 * `providerEdgeIds`.
 *
 * Exact via the block-cut tree: every simple path between two vertices
 * passes through exactly the blocks on the tree path between them,
 * entering and leaving each block at distinct vertices, and within a
 * single block (2-connected, or a lone bridge edge) some simple path
 * between any two of its vertices uses any one of its edges. So a vertex's
 * answer is the OR of each block's `hasProvider` over the blocks on its
 * tree path back to the root (the block or cut vertex holding `origin`).
 */
function hasProviderPathFrom(
  origin: string,
  edges: readonly ConnectionEdge[],
  providerEdgeIds: ReadonlySet<number>
): Map<string, boolean> {
  const adjacency = buildAdjacency(edges);
  if (!adjacency.has(origin)) return new Map();

  const blocks = biconnectedComponents(adjacency, origin);
  const hasProviderByBlock = blocks.map((block) =>
    block.edgeIds.some((edgeId) => providerEdgeIds.has(edgeId))
  );
  const { neighboursOf, isCutVertex } = buildBlockCutTree(blocks);
  const ownHasProvider = (node: TreeNode): boolean =>
    node.kind === "block" ? (hasProviderByBlock[node.index] ?? false) : false;

  const root: TreeNode = isCutVertex(origin)
    ? { kind: "vertex", id: origin }
    : { kind: "block", index: blocks.findIndex((b) => b.vertices.has(origin)) };

  const cumulativeByKey = new Map<string, boolean>();
  const rootKey = treeNodeKey(root);
  cumulativeByKey.set(rootKey, ownHasProvider(root));
  const visited = new Set<string>([rootKey]);
  const queue: TreeNode[] = [root];
  for (;;) {
    const current = queue.shift();
    if (current === undefined) break;
    const currentKey = treeNodeKey(current);
    for (const next of neighboursOf.get(currentKey) ?? []) {
      const nextKey = treeNodeKey(next);
      if (visited.has(nextKey)) continue;
      visited.add(nextKey);
      cumulativeByKey.set(
        nextKey,
        (cumulativeByKey.get(currentKey) ?? false) || ownHasProvider(next)
      );
      queue.push(next);
    }
  }

  const visitedVertices = new Set<string>();
  for (const block of blocks)
    for (const vertex of block.vertices) visitedVertices.add(vertex);

  const result = new Map<string, boolean>();
  for (const vertex of visitedVertices) {
    if (vertex === origin) continue;
    const vertexNode: TreeNode = isCutVertex(vertex)
      ? { kind: "vertex", id: vertex }
      : {
          kind: "block",
          index: blocks.findIndex((b) => b.vertices.has(vertex))
        };
    result.set(vertex, cumulativeByKey.get(treeNodeKey(vertexNode)) ?? false);
  }
  return result;
}
