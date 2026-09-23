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
Ordered by time, each attempt's `points_remaining_before` should therefore sit
one point below the previous attempt's `points_remaining_after`, and a wider
**drop** is spend by something this table did not record — a concurrent run,
another deployment, or a person with the same credentials. Any per-run cost
derived from a window containing one is contaminated.

A **rise** is the hourly reset refilling the allowance, which is expected and
is not flagged.

#### The one point

Reading the allowance is itself a metered Warcraft Logs request. Every run
opens by reading it, and that request's own point lands between the previous
run's closing reading and this run's opening one — so a perfectly clean
handover shows a gap of exactly 1, not 0.

That is the `- 1` in the query below. Measured, not assumed:
twelve consecutive handovers in `test` on 2026-09-19 were each exactly 1.00,
on a worker running strictly serially with nothing else holding the
credentials.

`raw_gap` is reported beside the adjusted figure so the constant stays
visible. If **every** row is off by the same non-zero amount, suspect the
constant rather than the runs — an upstream that started charging differently
for `rateLimitData` would look exactly like that, and a uniform offset is
never what real contamination looks like.

```sql
WITH handovers AS (
  SELECT recorded_at,
         run_id,
         attempt,
         points_remaining_before,
         lag(points_remaining_after) OVER w AS previous_remaining_after
  FROM character_evidence_run_costs
  WHERE recorded_at >= now() - interval '1 day'
    AND credentials = 'own'
    AND points_remaining_before IS NOT NULL
    AND points_remaining_after IS NOT NULL
  WINDOW w AS (ORDER BY recorded_at, run_id, attempt)
)
SELECT recorded_at,
       run_id,
       attempt,
       points_remaining_before,
       previous_remaining_after,
       round(
         (previous_remaining_after - points_remaining_before)::numeric, 2
       ) AS raw_gap,
       round(
         (previous_remaining_after - points_remaining_before - 1)::numeric, 2
       ) AS unaccounted_spend
FROM handovers
ORDER BY recorded_at, run_id, attempt;
```

A row whose `unaccounted_spend` is above about `0.01` is the marker. Scoped to
`credentials = 'own'` on purpose: a visitor's run draws on their own account's
counter, so its readings are not comparable to the worker's or to each other's.

One more reading of a wide gap, worth knowing before blaming a third party:
an attempt whose closing measurement failed has a null `points_remaining_after`
and drops out of this query entirely, so the comparison then spans _two_
handovers and the attempt in between. Its spend is genuinely unaccounted for —
that is why it is flagged — but the culprit is a run this table knows about
and failed to measure, not an outsider. Check the distribution query's
`attempts` against `measured` for the same window before concluding anything
else.

Settle the reserve from a window whose `window_moved` is zero and whose
`unaccounted_spend` is clean. A sample that fails either check describes
something other than what one run costs.

## What attendance recovery costs, and what it finds

Guild attendance is searched only for Mythic kills Raider.IO attributes to the
character that no stored or decoded evidence covers (#436). A kill an earlier
run already recovered is not searched for again. Instead, after a fresh scan
that finished (the only kind that publishes complete), the report of every
stored kill outside a terminal raid that the scan did not read is re-read
directly, because a complete publish keeps only what the run finds again
there. That list comes from stored evidence, never from Raider.IO, so a
Raider.IO failure cannot drop what it once helped find. After a full scan, it
is only the kills attendance recovered.

Recovery's requests are counted apart from the history scan:
`guild_attendance_requests` per attendance page, and
`report_hydration_requests` per report read, whether a search hit or a re-read.
All three draw on the same scan cap. Rows written before the split read zero in
both, with their recovery counted inside `history_scan_requests`.

A search never limits the run: a guild Warcraft Logs does not know, a page it
will not serve, or a spent budget recovers nothing and leaves the run's status
to its history scan. A re-read that fails for any reason other than the report
being gone **does** limit it, because the stored kill depends on it and a
partial publish is what carries that kill forward. A report that is gone
(Warcraft Logs answers "This report does not exist.") is a kill the run
stopped finding, which a complete publish is meant to drop.

### A `request_cap` that is not the cap

A resumed history scan never publishes complete (#437). When it reaches the end
of the history below its cursor it records `limitation_code = 'request_cap'`
and restarts from page one next time, although the cap was not reached. When
sizing the cap from `request_cap` rows, tell the two apart:
`history_scan_requests < request_cap_used` is a resumed scan that finished, not
budget exhaustion.

A kill whose first defeat was never logged is searched for again on every full
run until its tier settles, since nothing can hold it. The cost is one walk of
that guild's attendance back to the night, plus any reports on it that list the
character. This is accepted for now and tracked in #434. The query below is how
to tell whether it has become worth fixing: a group with `searches` well above
`kills_recovered`, and high `attendance_pages`.

The recovery columns carry the three evidence states this repository
distinguishes, and a query must not merge them:

- `raiderio_historic_outcome` is `evidence`, or the limitation Raider.IO
  answered with (`private`, `not_found`, `rate_limited`, `unavailable`,
  `schema_drift`). **Null means Raider.IO was not asked**: a light run or a
  parse-only resume, neither of which can search attendance.
- `raiderio_historic_ms` is how long the lookup took; null when not asked.
- `verified_kills_searched` is how many kills were left to search after
  stored evidence and the scan floor removed the rest. Re-reads are not
  counted here: they come from stored evidence, not from Raider.IO. `0` is a
  lookup that left nothing to search; null is no lookup.
- `attendance_recovered_kills` is how many kills an attendance search added
  that the run had not already found. Re-reads are not counted: they recover
  nothing new. Null when no attendance request was made, which can happen with
  kills to search when the history scan covers them or the budget is already
  spent. `0` is a search that found nothing.

Points are not split by class, so weigh cost with the per-request figures
measured one request at a time on 2026-09-23: about 28 points an attendance
page and about 6 a hydrated report.

```sql
SELECT raiderio_historic_outcome,
       count(*) AS attempts,
       count(verified_kills_searched) AS asked,
       coalesce(sum(verified_kills_searched), 0) AS kills_searched,
       count(attendance_recovered_kills) AS searches,
       coalesce(sum(attendance_recovered_kills), 0) AS kills_recovered,
       sum(guild_attendance_requests) AS attendance_pages,
       sum(report_hydration_requests) AS reports_hydrated,
       round(
         percentile_cont(0.5) WITHIN GROUP (ORDER BY raiderio_historic_ms)::numeric
       ) AS raiderio_p50_ms,
       max(raiderio_historic_ms) AS raiderio_max_ms
FROM character_evidence_run_costs
WHERE recorded_at >= now() - interval '7 days'
GROUP BY raiderio_historic_outcome
ORDER BY attempts DESC;
```

The `coalesce` is on the sums only, where "no rows contributed" and "the
rows contributed zero" answer the same question. The counts beside them keep
the not-asked rows visible: `attempts` minus `asked` is how many attempts never
asked Raider.IO, and `asked` minus `searches` is how many asked and had
nothing to search.

## What a tier search costs

A tier search is a full collection that also walks one tier's guild
attendance, asked for from the dossier (#435). It searches every guild known
for the character (Raider.IO's, the stored kills', and the ones Warcraft Logs
lists for the character) across the tier's current-content window. It hydrates
each report there that may list the character, whether or not it holds a kill
Raider.IO knows about, so guildless kills, wipe-only nights and kills below the
scan floor can be found.

It is reserved only by that explicit request, never by a read, a resume or a
retry, and at most once per tier per character a day. It has its own cap,
`EVIDENCE_TIER_SEARCH_REQUEST_CAP` (60 by default). The cap is carved out of
the run's scan cap, and the search takes at most half of it, so the run's
points budget is unchanged. It gallops through a guild's attendance to find
the window, then walks it page by page, so an old tier behind years of newer
reports costs a few requests a guild instead of one for every page in between.

Its rows carry `mode = 'tier_search'`, and these columns, all null on a run that
searched no tier:

- `tier_search_raid_id` is the Journal raid id the dossier asked for. It is
  present even when the search did not run, because the catalogue had no
  window for the raid.
- `tier_search_outcome` is `complete` (every guild walked across the whole
  window), `request_cap` (the search's own cap ran out) or `incomplete` (some
  guild's attendance or report could not be read). None of them limits the
  run: a search only ever adds evidence. Null means it never ran.
- `tier_search_requests`, `tier_search_guilds` and
  `tier_search_reports_hydrated` are what it spent and walked.
- `tier_search_recovered_kills` and `tier_search_recovered_wipes` are what it
  added that the run had not already found. `0` is a search that found
  nothing.

Its requests are also counted in the per-class columns:
`character_guilds_requests` (one, for the character's guild list),
`guild_attendance_requests` and `report_hydration_requests`.

```sql
SELECT tier_search_outcome,
       count(*) AS searches,
       sum(tier_search_requests) AS requests,
       sum(tier_search_guilds) AS guilds,
       sum(tier_search_reports_hydrated) AS reports_hydrated,
       sum(tier_search_recovered_kills) AS kills_recovered,
       sum(tier_search_recovered_wipes) AS wipes_recovered,
       round(avg(points_spent)::numeric, 1) AS mean_points,
       count(points_spent) AS measured
FROM character_evidence_run_costs
WHERE mode = 'tier_search'
  AND recorded_at >= now() - interval '28 days'
GROUP BY tier_search_outcome
ORDER BY searches DESC;
```

`mean_points` is the whole run's spend, not the search's alone. Points are not
split by class, so weigh it against the history scan and parse requests on the
same rows.

## Keeping this honest

`tests/integration/repositories.test.ts` extracts all four queries from this file
and runs them verbatim against a seeded database. A column renamed out from
under them fails the integration suite rather than leaving a document that
silently stopped being true.
