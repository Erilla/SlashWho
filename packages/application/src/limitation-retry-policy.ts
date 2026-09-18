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

    // Never reaches a publish: a budget refusal is recorded on the still-active
    // run and deferred by the queue, and on terminal refusal the run is failed
    // outright. The character comes back through the resume sweep, on the
    // deadline its previous completed run already carries.
    case "points_budget_low":
      return null;
  }
}
