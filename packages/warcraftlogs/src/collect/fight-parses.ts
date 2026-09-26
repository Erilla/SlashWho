import { parseGroupPlan, type ParseGroupPlan } from "../collection-plan";
import { isLimitation } from "../decode/primitives";
import {
  canonicalRankingCharacterIdsByIdentity,
  decodeCanonicalIdentityIds,
  decodeRankingRows,
  normalizedPerformance,
  type RankingIdentity,
  type RankingScope
} from "../decode/rankings";
import { toParseLimitation, type ParseLedger } from "../parse-ledger";
import {
  rankingCharacterIdentityQuery,
  reportFightParsesQuery
} from "../queries";
import { unavailableOnTimeout, type CollectionRun } from "./context";

type DecodedGroup = Readonly<{
  group: RankingScope;
  decoded: Extract<
    ReturnType<typeof decodeRankingRows>,
    { identities: readonly RankingIdentity[] }
  >;
}>;

/** Report rankings read so far, waiting on the shared identity lookup. */
export type FightParseHydration = Readonly<{
  plan: ParseGroupPlan;
  decodedGroups: readonly DecodedGroup[];
  identities: ReadonlyMap<number, RankingIdentity>;
}>;

/**
 * Every raid a group's fights belong to, so a failure can be attributed to the
 * tiers it actually touched rather than to the whole run.
 */
function troubleGroups(
  ledger: ParseLedger,
  plan: ParseGroupPlan,
  scopes: Iterable<RankingScope>
): void {
  for (const scope of scopes) {
    for (const raidId of plan.raidIds.get(scope.reportCode) ?? []) {
      ledger.troubleParses(raidId);
    }
  }
}

/**
 * Only a group that reached an answer is marked: a read cut short by the
 * budget, by rate limiting or by a response the decoder rejected learned
 * nothing about its fights.
 */
function markGroupsRead(
  ledger: ParseLedger,
  plan: ParseGroupPlan,
  scopes: Iterable<RankingScope>
): void {
  for (const scope of scopes) {
    for (const fightUrl of plan.fightUrls.get(scope.reportCode) ?? []) {
      ledger.markParsed(fightUrl);
    }
  }
}

/**
 * Reads each report group's rankings, one request a report, keeping one
 * request of `parseRequestCap` back for the identity lookup that follows.
 */
export async function hydrateFightParses(
  run: CollectionRun,
  ledger: ParseLedger
): Promise<FightParseHydration> {
  const { key, options } = run;
  const plan = parseGroupPlan(run.kills.values(), options);
  const decodedGroups: DecodedGroup[] = [];
  const identities = new Map<number, RankingIdentity>();
  for (const [index, group] of plan.groups.entries()) {
    // Reserve one request for the shared canonical identity lookup, so a cap
    // of N spends N-1 requests on rankings and one on identities.
    if (run.parseRequests + 1 >= options.parseRequestCap) {
      ledger.raise(
        { kind: "limitation", code: "parse_request_cap" },
        "fight_parses"
      );
      // Everything from here on was read by nobody, so none of the tiers
      // those reports belong to may settle on this run.
      troubleGroups(ledger, plan, plan.groups.slice(index));
      break;
    }
    run.parseRequests += 1;
    const rankings = await run.counted("fight_parses", () =>
      run.ctx
        .graphql(
          reportFightParsesQuery,
          { code: group.reportCode, fightIDs: [...group.fights.keys()] },
          options.signal
        )
        .catch(unavailableOnTimeout(options.signal))
    );
    if (rankings.kind !== "success") {
      ledger.raise(toParseLimitation(rankings), "fight_parses");
      troubleGroups(ledger, plan, plan.groups.slice(index));
      break;
    }
    const decoded = decodeRankingRows(rankings.value, group, key);
    if (isLimitation(decoded)) {
      ledger.raise(decoded, "fight_parses");
      // One report's rankings being unreadable says nothing about the next
      // report's, so the remaining budget hydrates the groups it can rather
      // than stopping the run at the first response the decoder rejects.
      // An unmatched identity is the same shape of answer and costs the
      // same one group -- it was `parse_schema_drift` until #349 split it,
      // and leaving it out here would abandon the rest of the budget over
      // a character who was merely unranked.
      if (
        decoded.code === "parse_schema_drift" ||
        decoded.code === "parse_identity_unmatched"
      ) {
        // An unmatched identity is an answer: the report ranked others and
        // none of them was this character, so there is nothing here to come
        // back for. Recording it is what stops the retry #350 introduced
        // from re-asking the same question every run (#297). Structural
        // drift is not an answer -- it says only that we could not read the
        // response -- so those fights stay eligible.
        if (decoded.code === "parse_identity_unmatched") {
          markGroupsRead(ledger, plan, [group]);
        }
        troubleGroups(ledger, plan, [group]);
        continue;
      }
      troubleGroups(ledger, plan, plan.groups.slice(index));
      break;
    }
    decodedGroups.push({ group, decoded });
    for (const identity of decoded.identities)
      identities.set(identity.id, identity);
  }
  return { plan, decodedGroups, identities };
}

/**
 * Confirms every ranked identity against Warcraft Logs' canonical record in
 * one request, then writes the requested character's percentiles onto the
 * run's kills.
 */
export async function applyCanonicalIdentities(
  run: CollectionRun,
  ledger: ParseLedger,
  hydration: FightParseHydration
): Promise<void> {
  const { key, options, kills } = run;
  const { plan, decodedGroups, identities } = hydration;
  const groups = decodedGroups.map(({ group }) => group);
  if (identities.size === 0) {
    // Every group that was read ranked nobody at all, so there is no
    // identity to canonicalise and nothing further to ask. Each of those
    // fights has its answer.
    markGroupsRead(ledger, plan, groups);
    return;
  }
  if (run.parseRequests >= options.parseRequestCap) {
    ledger.raise(
      { kind: "limitation", code: "parse_request_cap" },
      "ranking_identities",
      { preferExisting: true }
    );
    // The identity lookup is shared, so without it no decoded group gets
    // its performance applied: every tier they cover was read incompletely.
    troubleGroups(ledger, plan, groups);
    return;
  }
  const canonicalIdentities = [...identities.values()];
  const canonical = await run.counted("ranking_identities", () =>
    run.ctx
      .graphql(
        rankingCharacterIdentityQuery(canonicalIdentities),
        Object.fromEntries(
          canonicalIdentities.map((identity, index) => [
            `character${index}`,
            identity.id
          ])
        ),
        options.signal
      )
      .catch(unavailableOnTimeout(options.signal))
  );
  if (canonical.kind !== "success") {
    ledger.raise(toParseLimitation(canonical), "ranking_identities");
    troubleGroups(ledger, plan, groups);
    return;
  }
  const canonicalIds = decodeCanonicalIdentityIds(
    canonical.value,
    canonicalIdentities
  );
  if (isLimitation(canonicalIds)) {
    ledger.raise(canonicalIds, "ranking_identities");
    troubleGroups(ledger, plan, groups);
    return;
  }
  for (const [index, { group, decoded }] of decodedGroups.entries()) {
    const requestedIds = canonicalRankingCharacterIdsByIdentity(
      canonicalIds,
      decoded.identities,
      decoded.actors,
      key
    );
    if (isLimitation(requestedIds)) {
      ledger.raise(requestedIds, "ranking_identities");
      troubleGroups(ledger, plan, [group]);
      continue;
    }
    // No ranked appearance by this character in this report is an ordinary
    // gap - an unranked fight, or a report that ranks nobody - so the group
    // is left unparsed without a limitation. It is still an answer, so the
    // fights are recorded as read.
    if (requestedIds.length === 0) {
      markGroupsRead(ledger, plan, [group]);
      continue;
    }
    const performance = normalizedPerformance(
      decoded.rows,
      requestedIds,
      [...group.fights.keys()],
      options.className
    );
    if (isLimitation(performance)) {
      ledger.raise(performance, "ranking_identities");
      troubleGroups(ledger, plan, groups.slice(index));
      break;
    }
    markGroupsRead(ledger, plan, [group]);
    for (const [fightId, value] of performance) {
      for (const [fightUrl, kill] of kills) {
        if (kill.reportCode === group.reportCode && kill.fightId === fightId) {
          kills.set(fightUrl, { ...kill, performance: value });
        }
      }
    }
  }
}
