# Evidence run cost

What an evidence run actually spends, and how to settle the points budget from
it without reading a deployment log.

`EVIDENCE_POINTS_RESERVE`, `EVIDENCE_REQUEST_CAP` and
`EVIDENCE_PARSE_REQUEST_CAP` all carve up the same hourly Warcraft Logs
allowance, and all three are set from measured run cost. Until #342 that
measurement existed only as an `event="evidence_job"` line in the worker's
deployment logs, which `railway logs` serves for the current deployment alone —
so re-deriving any of the three meant iterating deployment ids and grepping
each. `character_evidence_run_costs` makes it a query.

## The table

One row per **attempt**, keyed `(run_id, attempt)`. A retry pays for its own
collection, so collapsing a run's attempts would hide exactly the spend the
retry cost ceiling is set from.

The row is written from the same record the `evidence_job` log line is built
from, at the same moment, so the two can never disagree. It carries no region,
realm or name: it is reachable from the run only by id.

Retention is **28 days**, swept by the worker's maintenance cleanup. Weeks, not
years, and deliberately: the question is always _what does a run cost now_, and
an older row describes a configuration that no longer runs. Keeping those
around would re-open the trap this table was built to close.

### Reading the columns

- `points_spent` is the run's own delta. **Null means unavailable** — the
  allowance could not be read — and is never a zero. A run that genuinely
  spent nothing reads `0`. Do not `coalesce` the two together; every query
  below counts the measured rows separately for this reason.
- `request_cap_used` and `parse_request_cap_used` are the caps the run was
  _given_, which since #320 are not the caps that are configured: the scan cap
  scales to the reported allowance. These two plus `credentials` are the
  grouping key — a distribution not grouped by them is an average across
  different budgets.
- `limitation_code` and `parse_limitation_code` say _why_ a run fell short.
  `outcome` alone tells you a run was limited but not by what, and the cost of
  a run that hit parse drift is not the cost of a clean one.

## Settling the reserve

The distribution of per-run spend over the last day, grouped by the
configuration in force. This is the query #342 asks for; everything else here
is a check on whether its rows can be trusted.

```sql
SELECT credentials,
       request_cap_used,
       parse_request_cap_used,
       limitation_code,
       parse_limitation_code,
       count(*) AS attempts,
       count(points_spent) AS measured,
       round(
         percentile_cont(0.5) WITHIN GROUP (ORDER BY points_spent)::numeric, 2
       ) AS p50,
       round(
         percentile_cont(0.9) WITHIN GROUP (ORDER BY points_spent)::numeric, 2
       ) AS p90,
       round(max(points_spent)::numeric, 2) AS max_spent,
       count(*) FILTER (
         WHERE points_spent IS NOT NULL
           AND points_remaining_before IS NOT NULL
           AND points_remaining_after IS NOT NULL
           AND abs(
                 points_spent
                 - (points_remaining_before - points_remaining_after)
               ) > 0.01
       ) AS window_moved
FROM character_evidence_run_costs
WHERE recorded_at >= now() - interval '1 day'
GROUP BY credentials, request_cap_used, parse_request_cap_used,
         limitation_code, parse_limitation_code
ORDER BY attempts DESC;
```

`attempts` minus `measured` is how many rows in that group have no spend
reading at all. The percentiles are over the measured rows only, because
PostgreSQL's ordered-set aggregates skip nulls — which is the behaviour wanted
here, and the reason the two counts are reported side by side rather than one
being inferred from the other.

`window_moved` is explained below; a group with a non-zero count there is not
a clean sample.

## Why three spend columns, not one

`points_spent`, `points_remaining_before` and `points_remaining_after` look
redundant. They are not, and the next person to read this schema will be
tempted to drop one, so: **keep all three.** They are what make a contaminated
measurement detectable by query instead of by somebody eventually noticing that
the arithmetic does not work. That has already produced three wrong numbers —
a 63.13-point per-page scan cost, a 2,998-point scan estimate, and the reserve
sample taken under a parse cap of 48.

The two checks are different, and the difference matters when deciding whether
to throw a sample away.

### Within a row: the window moved

`points_spent` is the delta of the account's `pointsSpentThisHour`;
`points_remaining_*` is `limitPerHour - pointsSpentThisHour` at each end. So
`points_spent = points_remaining_before - points_remaining_after` holds **by
construction**, as long as the reported limit is the same at both readings.

A non-zero residual therefore means the limit itself moved between them: the
hourly window reset mid-run, or the account's allowance changed. Either way the
two readings are not measuring the same hour and that row's spend is not a
clean sample of anything. That is the `window_moved` column above.

Note what this check does **not** catch: another run spending against the same
counter inflates both readings equally, so the residual stays zero. For that,
use the next one.

### Across rows: something else spent

Runs against the worker's own credentials all draw on one hourly counter.
Ordered by time, each attempt's `points_remaining_before` should therefore
equal the previous attempt's `points_remaining_after`. A **drop** between them
is spend by something this table did not record — a concurrent run, another
deployment, or a person with the same credentials — and any per-run cost
derived from a window containing one is contaminated.

A **rise** is the hourly reset refilling the allowance, which is expected and
is not flagged.

```sql
SELECT recorded_at,
       run_id,
       attempt,
       points_remaining_before,
       lag(points_remaining_after) OVER w AS previous_remaining_after,
       round(
         (lag(points_remaining_after) OVER w - points_remaining_before)::numeric,
         2
       ) AS unaccounted_spend
FROM character_evidence_run_costs
WHERE recorded_at >= now() - interval '1 day'
  AND credentials = 'own'
  AND points_remaining_before IS NOT NULL
  AND points_remaining_after IS NOT NULL
WINDOW w AS (ORDER BY recorded_at, run_id, attempt)
ORDER BY recorded_at, run_id, attempt;
```

A row whose `unaccounted_spend` is above about `0.01` is the marker. Scoped to
`credentials = 'own'` on purpose: a visitor's run draws on their own account's
counter, so its readings are not comparable to the worker's or to each other's.

Settle the reserve from a window whose `window_moved` is zero and whose
`unaccounted_spend` is clean. A sample that fails either check describes
something other than what one run costs.

## Keeping this honest

`tests/integration/repositories.test.ts` extracts both queries from this file
and runs them verbatim against a seeded database. A column renamed out from
under them fails the integration suite rather than leaving a document that
silently stopped being true.
