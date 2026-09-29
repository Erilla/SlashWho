# Reusing a fingerprint sweep across sibling roots

Issue: #719. Parent: #655.

**Status (2026-09-29): proposed, for the maintainer to agree.** Nothing here
is built. Implementation waits on this document and, as
[Sequencing](#sequencing) explains, on character groups phase 2 (#738).

## Problem

Sibling roots on one roster are each swept in full. On 2026-09-23,
eu/draenor/yawners, eu/silvermoon/yawnersw and yawnrs were each swept at 08:13,
402 requests apiece. A ryun-sized run spends about 3,440. Of the levers in
#655, reuse across roots is the only one that cuts requests rather than
speeding them up.

## What the sweep is, and why that decides the design

`discoverFingerprintMatches` reads the root's roster and achievement
fingerprint, then reads one candidate's fingerprint per request and keeps the
candidates whose fingerprint matches the root's (`packages/domain/src/
fingerprint-discovery.ts`). A fingerprint is a `Map<achievementId, timestamp>`
of about 3,100 entries. Nearly the whole cost is that per-candidate read, and
what a read yields is a comparison _against one root_.

Two facts follow.

1. **The reusable thing is expensive to keep.** Skipping a candidate read for a
   sibling needs that candidate's fingerprint, or a verdict that carries over
   from the first root to the second.
2. **The service already keeps the verdict that does carry over.** When a sweep
   from A finds B, #738 phase 1 writes a `fingerprint` connection between them
   and puts them in one group. "B is A's sibling" is a stored, derived fact.

## Options

| Option                                                                                                                                                 | Verdict         | Why                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Keep candidate fingerprints**, in the worker's memory or in Postgres                                                                              | Rejected        | The issue's own constraint says a full achievements payload cannot be cached, and a fingerprint is that payload with the fields dropped: about 37 KB per candidate as packed integers, 15 MB per 400-member roster. It would also be lost on every deploy in memory, and it would make Postgres the largest table in the service.                                                     |
| **B. Keep a sketch of each fingerprint** (a hash or minhash) to compare cheaply                                                                        | Rejected        | Small enough to store, but the match is a threshold (200 common, 20% identical), so a sketch gives an estimate near the threshold, and a wrong answer is not neutral: under transitive groups one false match joins two whole accounts on every page of both. #738 names it as the risk it accepts and mitigates with reviewer rejection, so it should not be widened by an estimate. |
| **C. Keep per-candidate verdicts against a root**, reuse them for a sibling                                                                            | Rejected        | "X did not match A" does not imply "X does not match B". The thresholds are not transitive, so a reused negative is a silent miss, and a silent miss is what the continuation design (2026-09-16) exists to remove. It also adds a table that grows by a roster per sweep.                                                                                                            |
| **D. Reuse the decision, not the data.** A sibling's sweep is `not_due` while another member of its group has swept the same roster within the cadence | **Recommended** | Stores nothing new. It uses the sibling link the service already holds, the cadence gate it already has, and the group union #738 already reads. It cuts the same requests as A to C for the case that matters, because a sibling on the same roster would re-read the same candidates.                                                                                               |
| E. Do nothing until groups phase 2 lands and the residual is measured                                                                                  | Fallback        | See [Measuring](#measuring-before-and-after). Option D is small enough that measuring first is optional.                                                                                                                                                                                                                                                                              |

## The gap that remains after groups, and that D closes

#738 phase 2 already stops a fresh group from being rediscovered, and makes the
weekly check for new guild members due once per group
(`scheduleConnectedCharacterSweep`, over the page's members). It does not
touch discovery's own sweep admission.

`requestAdmission` decides `not_due` from `fingerprint_sweep_states.
last_published_at` for **the run's root alone**
(`packages/database/src/fingerprint-sweeps.ts`, `requestAdmission`). So when a
group goes stale after `FRESHNESS_HOURS` (24 h) and a viewer opens sibling B,
the run is rooted at B, B's own state says it was last swept never or long ago,
and B is swept in full, even though A swept the same roster hours earlier and
its links are in the group. That is exactly the duplicated 402.

Groups shorten the window in which this happens from "always" to "when the
group is stale and a different member is opened", but the per-root gate leaves
it open indefinitely at 168 h.

## Design

### The gate

`requestAdmission` returns `not_due` for a non-continuation run rooted at B
when **all** of these hold, in addition to today's per-root test (which stays,
and still short-circuits first):

1. **A sibling swept recently.** Some member M of B's page members, other than
   B, has `fingerprint_sweep_states.last_published_at` newer than the cadence
   cutoff.
2. **The sweep covered B's roster.** M's guild and B's guild are the same guild.
   B's guild is the one this run's Raider.IO discovery just read for B, at no
   request. M's is the guild on M's row in its latest snapshot. Either being
   unknown fails the test, so the run sweeps.
3. **No chain is half-finished that would be abandoned.** No page member has a
   resumable cursor (`resume_after` set with fewer than
   `MAX_CONTINUATION_NON_PROGRESS_CYCLES` failures). A live chain will cover the
   roster and its cycles publish into the group. An abandoned chain (five
   failures) does not hold B off.
4. **B's own links are not about to lapse.** B's own `last_published_at`, when
   it has one, is newer than half of #738 phase 3's 90-day link expiry, 45
   days. See [Link expiry](#link-expiry).

Where any test fails, the sweep runs exactly as today. The gate can only remove
a sweep that a sibling on the same roster just did; it never adds one.

"Page members" is #738's definition (the walk over counting links within B's
group, suppressed characters neither shown nor walked through), so a suppressed
member cannot hold B's sweep off, and a rejected link is not a sibling.

### What a `not_due` sibling run publishes

Exactly what a `not_due` run publishes today: the Raider.IO characters, with
the sweep's admission marked `not_due` and no fingerprint links written or
retracted (#738: "the `not_due` case matters"). Its page reads the group union,
so the fingerprint characters M found are shown. Reading from groups is what
makes the skip safe; see below.

### What is stored

Nothing new. No table, column or migration. The gate reads three things the
service already holds, all derived and none provider-shaped:

- `fingerprint_sweep_states.last_published_at` and `resume_after`, per member;
- the group's members and counting links (#738);
- the guild on a member's snapshot row.

No fingerprint, candidate list, roster or match result is kept beyond the
sweep that read it, so the persistence rules in `CLAUDE.md` are untouched.

### Where

Postgres, in the existing admission transaction, which already holds the
`fingerprint-sweeps` advisory lock. The group read happens inside it, one
indexed lookup per member of a page (tens, not thousands). It takes no groups
lock: a stale read costs at worst one avoidable sweep (a link that lands a
moment later) or one skipped sweep (a link removed a moment earlier), and the
next weekly check corrects either. If reviewing shows it should be under the
groups lock, the lock order in #738 puts it after the fingerprint-sweeps lock,
which is where this read sits.

### How long

The existing `FINGERPRINT_SWEEP_CADENCE_HOURS`, 168 h, is the reference point
the issue names and is what the gate uses. No separate time to live exists to
tune or to drift from it.

What a skipped sweep costs in coverage is bounded by that 168 h and by the
roster: a new alt on the account, or a transfer, is missed by B's page for up to
a week, as it already is for A's. The rule "stored data must not outlive what it
describes" is met because the gate stores nothing that describes a candidate;
the sibling link it relies on is the one #738 already expires.

### How it shows up

It does not. A dossier gains no "reused" marker.

- A reused sweep is not a different kind of evidence. The characters on the page
  are the group's, each carrying its own source, as on every phase 2 page.
- **`partial`.** Research state is derived from the page members' latest
  snapshots (#738). If M's chain is capped, M's snapshot carries
  `fingerprint_sweep_capped`, the page is `partial`, and B's page inherits it.
  B's own `not_due` snapshot adds no limitation, so a reuse never turns a
  `partial` page `complete` and never turns a `complete` one `partial`.
- **`fingerprint_sweep_capped`.** Gate test 3 keeps B's sweep from being skipped
  in favour of a chain that has not sealed, so B's run is not held back by a
  capped sibling; it runs, or it waits for the chain, and the page stays
  `partial` until the chain seals either way.
- **Operators** see it in the run record: the run's outcome for a skipped sweep
  is the existing `not_due`, plus a new field `notDueBy: "self" | "group"` so a
  log query can count how many sweeps groups saved. This is a log field only.

### Sequencing

The gate must not ship before **phase 2 reads from groups**. Today a dossier
reads only its root's own snapshot. Skipping B's sweep before then would leave
B's page without the fingerprint characters M found, which drops evidence a
page shows now, and it breaks the "Same outcome, no data lost" goal. Phase 1
writes the groups but nothing reads them, so it cannot carry this either.

The order is therefore: phase 1 (merged) → phase 2 (reads) → this gate. It is
one pull request small enough to follow phase 2 directly, since it changes one
repository method, one call in the handler and one log field.

### Link expiry

#738 phase 3 expires an observed link 90 days after its observer last saw it,
and only re-observes when the observer is discovered again. If B's sweeps are
always skipped, B's own observations are never renewed, and would lapse while
their characters are still true. Two things prevent a silent cliff:

- Gate test 4 forces B to sweep for itself at least every 45 days, half the
  expiry, so its links are renewed well before they lapse.
- Phase 3's rule that a page adds the far ends of the opened character's own
  expired links keeps B's page whole in between.

The 45 days is a constant derived from the expiry constant, not a second
number, and a test should assert the relationship.

## Edge cases

| Case                                                                | Behaviour                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A and B in different guilds                                         | Test 2 fails, so B sweeps its own roster. Nothing is lost.                                                                                                                                                                                        |
| B changes guild after M's sweep                                     | B's guild, read this run, no longer equals M's, so B sweeps.                                                                                                                                                                                      |
| B left the group (link rejected, expired, or member suppressed)     | B is not a sibling, test 1 finds no member, B sweeps.                                                                                                                                                                                             |
| A first-ever search of two siblings before either is linked         | No link exists, so both sweep, as today. The second's admission runs after the first publishes (one discovery job at a time per worker), so it often finds the link and is skipped. Where the first is still a capped chain, test 3 defers to it. |
| M's snapshot has no guild (written before the column, or guildless) | Test 2 fails; B sweeps.                                                                                                                                                                                                                           |
| Continuation cycle                                                  | Unchanged. A continuation is exempt from the cadence gate and from this one (`continuation: true`).                                                                                                                                               |
| A user asks for a refresh of B                                      | Refreshing is a search, not the weekly check; it goes through the same admission and is skipped the same way. The Raider.IO half still refreshes.                                                                                                 |
| Roster churn: B's guild gains a member after M swept                | Missed for up to 168 h, as for M today.                                                                                                                                                                                                           |

## Testing

Test-first, following the existing suites.

- `tests/integration/repositories-discovery.test.ts`: two characters in one
  group and one guild, M swept 1 h ago: B's admission is `not_due`. Then vary
  one thing at a time and expect a sweep: M swept 200 h ago; different guild;
  no guild; B not in M's group; a rejected link; M suppressed; M mid-chain;
  M's chain abandoned; B's own sweep 46 days old. Each is its own test, so a
  failing gate names the test that broke.
- `packages/application/src/discovery-job-handler.test.ts`: a group `not_due`
  publishes the Raider.IO snapshot, writes no fingerprint observation, and
  records `notDueBy: "group"`.
- A test that the 45-day bound is derived from the link expiry constant.
- A phase 2 page test, in the same pull request as the gate: B's page after a
  group `not_due` shows the characters M found and the limitation M's snapshot
  carries.
- No live Blizzard or Raider.IO traffic.

## Measuring before and after

Two questions decide whether this is worth its pull request: how many sweeps
today are for a sibling swept within the cadence, and how many requests they
spend. Run on Railway test once phase 1's tables hold a few days of data (#745
deployed 2026-09-29). **This query was written for this document and has not
been run.** Group membership is read as it is now, not as it was at the sweep,
and each continuation cycle is its own admission row, so read the counts as an
upper bound on sweeps and a fair figure for requests.

```sql
WITH sweeps AS (
  SELECT c.id AS character_id, m.group_id, a.requested_at, r.used_count
  FROM fingerprint_sweep_reservations r
  JOIN fingerprint_sweep_admissions a ON a.id = r.admission_id
  JOIN characters c
    ON c.region = a.region
   AND c.realm_slug = a.realm_slug
   AND c.normalized_name = a.normalized_name
  JOIN character_group_members m ON m.character_id = c.id
  WHERE r.used_count > 0
    AND a.requested_at > now() - interval '28 days'
)
SELECT
  count(*)                       AS sweep_cycles,
  sum(s.used_count)              AS requests,
  count(*) FILTER (WHERE covered) AS sibling_covered_cycles,
  sum(s.used_count) FILTER (WHERE covered) AS sibling_covered_requests
FROM (
  SELECT s.*,
         EXISTS (
           SELECT 1 FROM sweeps p
           WHERE p.group_id = s.group_id
             AND p.character_id <> s.character_id
             AND p.requested_at < s.requested_at
             AND p.requested_at >= s.requested_at - interval '168 hours'
         ) AS covered
  FROM sweeps s
) s;
```

The guild condition (test 2) is not in the query, so it overstates what the
gate would remove; the yawners case, where all three roots share one roster, is
the upper end.

After the gate ships, count `notDueBy: "group"` records against all
`discovery_run` sweep records over the same window, and compare requests per
hour against `BLIZZARD_HOURLY_REQUEST_BUDGET` (28,800), of which a full run
spends about 12%.

## Decisions for the maintainer

1. **Agree option D**, over keeping any candidate data (A to C).
2. **Sequence after phase 2.** Confirm the gate waits for reads to switch.
3. **The guild test (gate test 2).** It makes the gate narrower than "same
   group", so B's own roster is never left unswept. The alternative is to gate
   on the group alone, matching how #738 already accepts that the weekly check
   walks one member's guilds per group; it saves more and covers less. This
   design chooses the narrower test because the issue suggests "only when the rosters
   match".
4. **The 45-day bound (gate test 4).** It exists only because of phase 3's
   expiry. If phase 3 changes or is dropped, this test changes with it.

## Out of scope

- Any storage of candidate fingerprints, sketches or per-candidate verdicts.
- Reusing a sweep for a sibling in a **different** guild. Its roster is not
  covered.
- Carrying the candidate list in the resume cursor, or the per-cycle setup
  reads (#655, lever 3).
- Raising `BLIZZARD_SWEEP_REQUEST_CAP` or the rate limit.
- A "reused" marker in the dossier response.
