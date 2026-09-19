import type { WarcraftLogsLimitationCode } from "@slashwho/warcraftlogs";

/**
 * How long a run that ended in one limitation waits before it is collectable
 * again, or `null` when waiting cannot help.
 *
 * Distinct from `evidence-retry-policy`, which decides whether a *thrown*
 * failure earns another queue attempt. This is about a run that completed and
 * published: the collection went as well as it was going to, and the question
 * is whether the character should be collected again later.
 *
 * `retry_after_at` is the only signal that makes `reserve` hand a character
 * back, so a code with no answer here settles permanently short of the
 * evidence the run knows it did not fetch. That was the right answer for a
 * character with no public logs and the wrong one for a transport blip, and
 * the two were indistinguishable while every code returned nothing.
 *
 * This fills a hole rather than overriding upstream: a limitation carrying its
 * own `Retry-After` keeps it, because upstream knows better than a default
 * when upstream is the one asking us to wait.
 *
 * The switch is exhaustive on purpose, with no `default`. A limitation code
 * added without a decision here should be a type error, not another character
 * quietly stranded.
 */
/**
 * Which of the parse limitations one run raised drives its retry, and so is
 * the code the run records.
 *
 * A run can raise several and the record holds one, so something has to
 * choose. Until #349 nothing did: whichever assignment ran last won, and a
 * parse budget running out late in the hydration loop overwrote a more
 * informative failure raised earlier. That is how an unmatched ranking
 * identity hid behind `parse_request_cap` for weeks.
 *
 * The obvious repair -- keep the first, as the sibling `??=` did -- is worse,
 * because it lets a code with no retry suppress one that has a retry and
 * strand the character until its evidence goes stale. So neither "first" nor
 * "last" is the rule:
 *
 * **A limitation that earns a retry wins.** A character is never left
 * uncollectable by one limitation when another one the same run raised would
 * have rescheduled it. Among equals, the first raised wins, being the earlier
 * and more specific failure. Nothing is discarded either way -- the rest are
 * recorded on the run, which is the point.
 */
export function drivingParseLimitation<
  T extends Readonly<{
    code: WarcraftLogsLimitationCode;
    retryAfterMs?: number;
  }>
>(
  limitations: readonly T[],
  options: Readonly<{ transientRetryMs: number; capRetryMs: number }>
): T | undefined {
  return (
    limitations.find(
      (limitation) =>
        (limitation.retryAfterMs ??
          retryDelayMsFor(limitation.code, options)) !== null
    ) ?? limitations[0]
  );
}

export function retryDelayMsFor(
  code: WarcraftLogsLimitationCode,
  options: Readonly<{ transientRetryMs: number; capRetryMs: number }>
): number | null {
  switch (code) {
    // Transport and throttling, not judgement. The character's logs exist and
    // we failed to read them, so the same request may well succeed shortly;
    // and throttling always ends, upstream usually saying when. This is what
    // applies when it did not.
    case "unavailable":
    case "parse_unavailable":
    case "rate_limited":
    case "parse_rate_limited":
      return options.transientRetryMs;

    // Our own budget, not upstream's: the run stopped early by policy with
    // work it knows is outstanding.
    case "request_cap":
    case "parse_request_cap":
      return options.capRetryMs;

    // A character with no public logs will not acquire them by waiting, and a
    // private one will not be opened by asking again.
    case "not_found":
    case "private":
    case "parse_private":
      return null;

    // Drift is a decoding bug on our side. Retrying re-runs the same failing
    // parse; only a code fix -- and the rebuild that follows it -- resolves it.
    case "schema_drift":
    case "parse_schema_drift":
      return null;

    // Not a decoding bug, despite having been filed as one until #349. The
    // report's ranking rows could not be matched to this character, which is
    // usually a character who was in the fight and simply unranked -- benign,
    // and reached often enough that leaving it unretryable stalled 7 of 10
    // characters for a day the moment #346 stopped the parse budget masking
    // it. A later run may also find the fight ranked, which retrying is
    // exactly the way to discover.
    case "parse_identity_unmatched":
      return options.transientRetryMs;

    // Never reaches a publish: a budget refusal is recorded on the still-active
    // run and deferred by the queue, and on terminal refusal the run is failed
    // outright. The character comes back through the resume sweep, on the
    // deadline its previous completed run already carries.
    case "points_budget_low":
      return null;
  }
}
