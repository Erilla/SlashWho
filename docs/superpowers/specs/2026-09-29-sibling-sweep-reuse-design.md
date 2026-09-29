# Reusing a fingerprint sweep across sibling roots

Issue: #719. Parent: #655.

**Status (2026-09-29): proposed, for the maintainer to decide.** Nothing here
is built. Revised after design review on PR #752. The recommendation is now
conditional: measure first, and build the narrowed gate only if the measurement
justifies it. See [Recommendation](#recommendation).

## Problem

Sibling roots on one roster are each swept in full. On 2026-09-23,
eu/draenor/yawners, eu/silvermoon/yawnersw and yawnrs were each swept at 08:13,
402 requests apiece. A ryun-sized run spends about 3,440. Of the levers in
#655, reuse across roots is the only one that cuts requests rather than
speeding them up.

**What that evidence does and does not show.** 402 is above
`BLIZZARD_SWEEP_REQUEST_CAP` (300 by default), so each of the three was a
continuation chain, and all three were admitted in the same minute, before any
had published. Nothing in this design would have removed any of them: no
sibling had a sealed sweep to lean on. I did not check what the cap on test was
on 2026-09-23. So the motivating case is a concurrency case, and only
character groups (#738) address the part of it that follows the first
publication. The saving this design offers rests on a measurement nobody has
taken yet.

## What the sweep is, and why that decides the design

`discoverFingerprintMatches` reads the root's roster and achievement
fingerprint, then reads one candidate's fingerprint per request and keeps the
candidates whose fingerprint matches the root's (`packages/domain/src/
fingerprint-discovery.ts`). A fingerprint is a `Map<achievementId, timestamp>`
of about 3,100 entries. Nearly the whole cost is that per-candidate read, and a
read yields a comparison _against one root_.

Two facts follow.

1. **The reusable thing is expensive to keep.** Skipping a candidate read for a
   sibling needs that candidate's fingerprint, or a verdict that carries over
   from one root to the other.
2. **The service already keeps the verdict that does carry over, in part.**
   When a sweep from A finds B, #738 phase 1 writes a `fingerprint` connection
   and puts them in one group, and its ledger records whether each sweep
   `matched`, was `unread`, `capped` or `skipped_guild`.

## Options

| Option                                                                                                                                                       | Verdict               | Why                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Keep candidate fingerprints**, in the worker's memory or in Postgres                                                                                    | Rejected              | The issue allows a stored fingerprint if it is derived and minimal. This one is derived but not minimal, and it is rejected on three grounds: size (about 37 KB per candidate as packed integers, 15 MB per 400-member roster), churn (it changes with every achievement, so it needs its own expiry), and, in memory, loss on every deploy. In Postgres it would be the largest table in the service. |
| **B. Keep a sketch of each fingerprint** (a hash or minhash)                                                                                                 | Rejected              | Small enough to store, but the match is a threshold (200 common, 20% identical), so a sketch gives an estimate near the threshold. A wrong answer is not neutral: under transitive groups, one false match joins two whole accounts on every page of both. #738 names that as a risk it accepts and mitigates with reviewer rejection, so an estimate should not widen it.                             |
| **C. Keep per-candidate verdicts against a root**, reuse them for a sibling                                                                                  | Rejected              | "X did not match A" does not imply "X does not match B". The thresholds are not transitive, so a reused negative is a silent miss. It also adds a table that grows by a roster per sweep.                                                                                                                                                                                                              |
| **D. Reuse the decision.** A sibling's sweep is `not_due` while another member of its group has a sealed, matched sweep of the same guild within the cadence | Conditional           | Stores nothing new and adds no candidate data. **It does reuse a negative in the same sense as C** (see [The miss D accepts](#the-miss-d-accepts)): a candidate that would match B and not M is never compared against B while B is skipped. That is a stated cost and a maintainer decision, bounded below. It is narrowed to the point where it saves little, so it is built only if measured.       |
| E. Do nothing until groups phase 2 has shipped and the residual is measured                                                                                  | **Recommended first** | Phase 2 already stops a fresh group being rediscovered, and makes the weekly check once-per-group. What is left may be small. See [Measuring](#measuring-before-and-after).                                                                                                                                                                                                                            |

## Recommendation

1. **Do E first.** Ship phase 2, then run the [measurement](#measuring-before-and-after).
2. **Build D, narrowed as below, only if** sibling-covered requests are more
   than about a tenth of sweep requests over a four-week window. Below that, the
   miss D accepts costs more in coverage than it saves in requests, and the
   issue closes without an implementation.
3. **Do not build A, B or C.**

The rest of this document specifies D so that the decision in step 2 can be
taken from numbers rather than from a second design round.

## The gap that remains after groups

#738 phase 2 stops a fresh group being rediscovered and makes the weekly check
for new guild members due once per group (`scheduleConnectedCharacterSweep`,
over the page's members). It does not touch discovery's own sweep admission.

`requestAdmission` and `admitWaiting` decide `not_due` from
`fingerprint_sweep_states.last_published_at` for **the run's root alone**
(`packages/database/src/fingerprint-sweeps.ts`). So when a group goes stale
after `FRESHNESS_HOURS` (24 h) and a viewer opens sibling B, whether by an
explicit search or the `groupStale` start, the run is rooted at B, B's own
state says it was last swept long ago, and B is swept in full even though M
sealed a sweep of the same roster hours earlier.

## Design (if D is built)

### The gate

A run rooted at B, that is not a continuation, is `not_due` when today's
per-root test says so, or when **all** of these hold. Any failure means B
sweeps exactly as today; the gate only ever removes a sweep.

1. **A sibling has a sealed, matched sweep.** Some member M of B's page members,
   other than B, has a fingerprint-family row in #738's ledger whose reason is
   `matched` and whose `written_at` is newer than the cadence cutoff, and no
   later fingerprint-family row for M. Not `unread`, `capped` or `skipped_guild`:
   those publish without having read the roster, and a cycle of a live chain is
   `continuation`, not `matched`. (`last_published_at` is not used: it is set by
   every publish, including those.)
2. **M is a sibling in the sense that counts.** M is reached from B through
   `observed` provider links that count, and is not excluded. Manual
   connections, reviewer-excluded characters, and from phase 3 the far ends of
   expired links do not qualify.
3. **The sweep covered B's roster.** M's guild and B's guild are the same guild,
   compared as the sweep compares them, by `canonicalGuildId`'s
   region/realm/name key with the Blizzard-side spelling. M's guild is read
   from the snapshot the sealing run published or amended (the ledger row's
   `run_id`), not from M's latest snapshot, so a later refresh cannot make it
   look like B's. B's guild is the one read for B by this run. Either being
   unknown fails the test. Historical guilds are not compared; see
   [Decisions](#decisions-for-the-maintainer).
4. **No chain is live.** No page member has a resumable cursor, live or
   abandoned (`resume_after` set). B's own cursor in particular sends B down
   today's path, so `getResumeState` and `completeWithLiveSweepSnapshot` are
   never reached for a group skip.
5. **B's own sweep is recent and clean.** B has its own ledger row with reason
   `matched` newer than `SIBLING_REUSE_MAX_OWN_SWEEP_AGE_HOURS`, and its
   published `limitation_code` was null. A B that has never had its own matched
   sweep always sweeps.

Test 4 answers "does a live chain hold B off?" with **no**: a live sibling chain
does not count as coverage and B sweeps. There is no waiting mechanism and none
is added. The cost is that a capped first sweep is duplicated by its siblings,
which is the yawners case; see [Problem](#problem).

Test 5 is what makes a `not_due` snapshot honest. See
[What a group `not_due` publishes](#what-a-group-not_due-publishes).

### The miss D accepts

D skips B because M swept. A candidate X that matches B's fingerprint but falls
below the threshold against M's is never compared against B. Today B's search
would find it. Under D it is absent from B's group until B next sweeps for
itself, and members opened in turn can keep B skipped that whole time.

The bound is `SIBLING_REUSE_MAX_OWN_SWEEP_AGE_HOURS`, B's own sweep age (test 5),
28 days: four cadences. It is a local constant. It must stay at or under half
of phase 3's link expiry (90 days, so 45), so B's own links are renewed
before they lapse; phase 3's pull request should assert that relationship
when the expiry constant exists. Until then, nothing else in the repository
depends on it.

Members of one account share their account-wide achievements, so a
candidate on the account nearly always matches every sibling; the miss needs a
character just under the threshold against one and over it against another.
That is a judgement, not a measurement, and it is the reason the decision below
is the maintainer's.

### What a group `not_due` publishes

What a `not_due` run publishes today: the Raider.IO characters, the admission
marked not due, and no fingerprint links written or retracted (#738: "the
`not_due` case matters"). Its research state is Raider.IO's own.

That could turn a partial page complete: B last chained and capped (partial),
M later matched, B is opened, and a Raider.IO-only `complete` snapshot would say
the fingerprint was checked. Test 5 prevents it by construction. B is skipped
only if its own last sweep was a clean match, so its fingerprint _was_
compared, within 28 days, and nothing partial is being hidden. A B whose own
last sweep was capped or unread fails test 5 and sweeps. There is no new
limitation code, and none is carried forward.

The page is then as complete as its members' snapshots say, as on every
phase 2 page. If M's chain later caps, M's snapshot carries
`fingerprint_sweep_capped` and B's page is `partial`.

### Where the gate runs

**`requestAdmission` and `admitWaiting` both.** A run that queued behind the
hourly budget is later admitted by `admitWaiting`, which has its own per-root
test, and by the head-of-queue filter in `admitFingerprintWaitingRun`. Gating
only the first would let a queued B through once the budget frees. So this is
one shared helper called from both, not "one method".

**Decided outside the lock, honoured inside.** #738's lock order takes the
rebuild lock and the groups lock before the fingerprint-sweeps lock, and
`pageMembers` is a link walk with suppression checks, not one lookup. So the
gate is computed before the admission transaction, from a consistent read, and
passed in as a flag (`siblingCovered`), the way #738 passes `sweepDue`. The
transaction honours the flag and takes no group lock. A stale flag costs at
worst one avoidable sweep or one skipped sweep, and the weekly check corrects
either.

### What is stored

Nothing new for the decision: it reads #738's ledger, connections and
groups, `fingerprint_sweep_states`, and the guild on snapshot rows. For
counting, a skipped run's admission ends with a distinct status, `not_due_group`,
instead of `not_due`. The column is unconstrained text, so this needs no
migration, and it makes the saving measurable from tables rather than from
logs. No fingerprint, candidate list, roster or match result is kept beyond the
sweep that read it.

### How long

The existing `FINGERPRINT_SWEEP_CADENCE_HOURS`, 168 h, for M's sweep (test 1),
and 28 days for B's own (test 5). Nothing stores anything describing a
candidate, so nothing outlives what it describes.

### How it shows up

It does not, in the dossier: no "reused" marker. Operators see
`not_due_group` in `fingerprint_sweep_admissions`.

### After the skip: split, suppression, rejection

If M is later suppressed, rejected or removed, characters linked to B only
through M leave B's page, and nothing re-runs B until freshness lapses. That is
the same for every group member and is #738's behaviour, not new here. It heals:
M is no longer a page member, so the weekly check is due for B's group if no
other member swept within the cadence.

### Explicit refresh

A user's explicit refresh of B goes through the same admission and is skipped
the same way. The Raider.IO half still refreshes. Whether an explicit search
should bypass the gate is a decision below, not an edge case.

## Edge cases

| Case                                                           | Behaviour                                                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| M's roster or profile read 404 (`unread`)                      | Test 1 fails: the ledger row is `unread`. B sweeps.                                                   |
| M capped in cycle 1 before reading anything                    | Reason is `capped`, no `matched`. B sweeps.                                                           |
| M's chain abandoned after five failures                        | Test 4: `resume_after` is still set, and there is no `matched` row. B sweeps.                         |
| M matched, then a later `not_due` refresh moved M to B's guild | M's guild is from the sealing run's snapshot, so the mismatch stands. B sweeps.                       |
| A and B in different guilds                                    | Test 3 fails. B sweeps its own roster.                                                                |
| B changes guild after M's sweep                                | B's guild, read this run, differs. B sweeps.                                                          |
| B never swept for itself                                       | Test 5 fails. B sweeps.                                                                               |
| B has its own abandoned or live cursor                         | Test 4. B takes today's path.                                                                         |
| B left the group, or M was rejected, excluded or suppressed    | Test 1 or 2 finds no qualifying member. B sweeps.                                                     |
| Two siblings searched before either is linked                  | No link, so both sweep, as today. Where the first is a live chain, test 4 makes the second sweep too. |
| Continuation cycle                                             | Exempt from the cadence gate and from this one (`continuation: true`).                                |
| Budget pressure, B waits in `admitWaiting`                     | Same gate, evaluated again when the row is considered.                                                |

## Testing

Test-first. Each variation is its own test so a failing gate names the case.

- `tests/integration/repositories-discovery.test.ts`, through both
  `requestAdmission` and `admitWaiting`: M and B in one group and guild, M's
  matched sweep 1 h ago and B's own 10 days ago: `not_due_group`. Then one
  change at a time, each expecting a sweep: M `unread`; M `capped` with no
  cursor; M's chain abandoned; M's sweep 200 h ago; M's guild changed by a
  later refresh; different guild; no guild; B not in the group; a rejected
  link; M suppressed; M excluded or reached only by a manual link; B never
  swept; B's own cursor set; B's own sweep at the constant minus and plus one
  hour, both computed from the constant.
- A test that B with a capped own last sweep (partial) and M complete
  **sweeps**, so a partial page is never published as complete. This one fails
  if test 5 is removed.
- `packages/application/src/discovery-job-handler.test.ts`: a group skip
  publishes the Raider.IO snapshot, writes no fingerprint observation, and never
  calls `getResumeState` or `completeWithLiveSweepSnapshot`.
- A phase 2 page test in the same pull request: B's page after a group skip
  shows the characters M found and the limitation M's snapshot carries.
- No live Blizzard or Raider.IO traffic.

## Measuring before and after

Two questions decide whether D is worth building: how many sweep requests
would the gate have removed, and does that clear the tenth in
[Recommendation](#recommendation). Run this on Railway test **after phase 2
has been live for four weeks**; before that it credits D with sweeps phase 2's
group-wide weekly check already removes. **It has not been run.** It is
read-only. Group membership is read as it is now, not as at the sweep, so treat
the result as an estimate.

It counts only what the gate would remove: sweeps whose sibling had a
_matched_ ledger row earlier, at least a moment before this sweep's run began,
within 168 h, and whose own previous matched sweep was within 28 days. Capped,
unread and mid-chain sweeps do not count as coverage.

```sql
WITH matched AS (
  SELECT l.observer_character_id AS character_id,
         m.group_id,
         l.written_at
  FROM character_connection_write_log l
  JOIN character_group_members m ON m.character_id = l.observer_character_id
  WHERE l.family = 'fingerprint'
    AND l.reason = 'matched'
),
sweeps AS (
  SELECT l.observer_character_id AS character_id,
         m.group_id,
         l.run_started_at,
         r.used_count
  FROM character_connection_write_log l
  JOIN character_group_members m ON m.character_id = l.observer_character_id
  JOIN fingerprint_sweep_reservations r ON r.id = l.sweep_reservation_id
  WHERE l.family = 'fingerprint'
    AND l.reason = 'matched'
    AND l.written_at > now() - interval '28 days'
)
SELECT
  count(*)          AS sealed_sweeps,
  sum(s.used_count) AS requests,
  count(*) FILTER (WHERE covered) AS covered_sweeps,
  sum(s.used_count) FILTER (WHERE covered) AS covered_requests
FROM (
  SELECT s.*,
         (
           EXISTS (
             SELECT 1 FROM matched p
             WHERE p.group_id = s.group_id
               AND p.character_id <> s.character_id
               AND p.written_at < s.run_started_at
               AND p.written_at >= s.run_started_at - interval '168 hours'
           )
           AND EXISTS (
             SELECT 1 FROM matched own
             WHERE own.character_id = s.character_id
               AND own.written_at < s.run_started_at
               AND own.written_at >= s.run_started_at - interval '28 days'
           )
         ) AS covered
  FROM sweeps s
) s;
```

Caveats: a chain's requests are attributed to its sealing cycle's reservation
only, so `requests` understates chains; guild equality (test 3) and test 2's
exclusions are not in the query, so `covered` overstates. After D ships,
count `not_due_group` against sweep admissions in the table.

Budget: a full ryun-sized run spends about 12% of
`BLIZZARD_HOURLY_REQUEST_BUDGET` (28,800), which charges discovery sweeps only.
The worker's 40 a second limit is the other ceiling.

## Decisions for the maintainer

1. **Whether to build D at all**, or stop at E and close #719 after the
   measurement. Recommended: E first, D only above about a tenth.
2. **The non-transitive miss** ([above](#the-miss-d-accepts)), bounded at 28
   days of B's own sweep age. Accept, or drop D.
3. **A live sibling chain does not hold B off** (test 4); B sweeps. The
   alternative, a waiting mechanism, is not proposed.
4. **What a group skip publishes.** Proposed: nothing new. Test 5 means B's
   fingerprint was recently compared, so the Raider.IO-only snapshot is not
   misleading. The alternative is a `partial` snapshot with a limitation such as
   `fingerprint_sweep_by_sibling`, which would leave every sibling page partial.
5. **Historical guilds are not compared.** B's historical guild rosters are not
   walked while it is skipped, bounded by the same 28 days. The alternative is
   requiring B's set to be a subset of M's frozen one.
6. **Who counts as a sibling.** Observed, counting, non-excluded provider links
   only (test 2).
7. **Ship after phase 2, and before or after phase 3.** Proposed: after phase 2,
   with a local 28-day constant that phase 3 must keep at or under half of its
   expiry. The alternative is waiting for phase 3.
8. **Whether an explicit user refresh bypasses the gate.** Proposed: no. The
   alternative is to bypass it for landing-page searches and gate only the
   `groupStale` start.
9. **Admission status.** A distinct `not_due_group`, over a log field.

## Out of scope

- Storing candidate fingerprints, sketches or per-candidate verdicts.
- Reusing a sweep for a sibling in a **different** guild.
- Carrying the candidate list in the resume cursor, or the per-cycle setup
  reads (#655, lever 3).
- Raising `BLIZZARD_SWEEP_REQUEST_CAP` or the rate limit.
- A "reused" marker in the dossier response.
- Fixing `getResumeState` and `completeWithLiveSweepSnapshot` ignoring
  `continuation_failures`. It is an existing gap the review found; the gate
  avoids reaching it, and it deserves its own issue.
