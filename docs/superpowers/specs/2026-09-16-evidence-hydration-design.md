# Evidence hydration: current-tier completeness and background backfill

Status: proposed
Date: 2026-09-16

## Problem

Parse hydration cannot finish, and cannot resume.

A dossier shows a parse for each Mythic kill. Those parses come from Warcraft
Logs report rankings, one request per report, bounded by
`EVIDENCE_PARSE_REQUEST_CAP`. Three properties combine badly.

**Hydration stops for 24 hours at a time.** A run that exhausts the parse cap
publishes as `complete`, because only a scan-level limitation makes a run
`partial`:

```ts
state: response.limitation ? "partial" : "complete";
```

`retryAfterAt` is set only for a rate-limit backoff, never for a cap. So the
run is fresh for `FRESHNESS_HOURS` (24) and `reserve()` refuses to collect
again. Each character therefore gets one hydration batch per day. Measured on
`eu/silvermoon/ryii`, one character spans 353 reports; at a cap of 12 that is
roughly a month to hydrate.

**Every collection change needs an evidence-version bump, and each bump
re-collects every character at once.** Three bumps on 2026-09-16 — to versions
10, 11 and 12 — each forced a full ten-character sweep, on top of one the
evening before. Warcraft Logs throttled the result for hours, with backoffs
growing from 689,000ms to 1,443,000ms.

**Nothing distinguishes "not fetched" from "nothing to fetch".** A kill whose
metrics are `unavailable` may be one never requested, or one requested whose
fight Warcraft Logs holds no rank for. Without that distinction a continuation
run either repeats work forever or stops too early.

## Goal

A dossier's **current tier is complete on first view**. Older tiers fill in
across subsequent visits rather than waiting a day per batch, and the interface
says so while it is happening.

Two raids are in-window as of this date (The Venomous Abyss, The Tidebound
Grotto), which is ten parse rows on the reference dossier — not the 931 reports
a whole history spans. Current-tier completeness is a small target.

## Design

### 1. Parse state semantics

The parse state enum already has the vocabulary. Give the third value meaning:

| state            | meaning                                               |
| ---------------- | ----------------------------------------------------- |
| `available`      | a percentile is stored                                |
| `not_applicable` | requested; Warcraft Logs holds no rank for this fight |
| `unavailable`    | not yet requested                                     |

When a report is fetched and a fight returns no ranking row, record
`not_applicable` rather than `unavailable`.

"What still needs hydrating" becomes a query: in-window kills whose metrics are
`unavailable`. It also supplies the termination condition — a character whose
kills genuinely have no ranks converges to all-`not_applicable` and stops being
re-collected. No new column.

### 2. Continuation runs

`reserve()` currently returns `fresh` when evidence is recent. It should return
`fresh` only when evidence is recent **and** hydration is complete. Hydration is
incomplete when in-window kills remain `unavailable` and the last run stopped on
a cap — `character_evidence_runs.parse_limitation_code` already records that.

Otherwise `reserve()` admits a **continuation run**, which differs from a normal
run in one way: it does not scan reports. The kills are already stored, so it
spends its entire budget on ranking requests. Report pagination is the bulk of a
run's request volume, so a continuation is far cheaper than a re-collection.

The gateway keeps one entry point. `getFirstKillReports` gains stored kills as
an input; when supplied, the scan phase is skipped.

### 3. Current-tier scoping

#250 orders hydration by first-kill-then-newest. Make it a scope rather than
only an ordering: hydrate in-window raids to completion first, and spend
remaining budget on older tiers. With two raids in-window the current tier
finishes inside one run, which makes backfill genuinely background work.

### 4. Saying so in the interface

The present message is misleading under this design:

> Parse availability is partial because this dossier reached its parse request
> cap. Verified kill evidence is still shown.

That reads as terminal. It should distinguish three cases:

| situation                              | message                                     |
| -------------------------------------- | ------------------------------------------- |
| in-window kills `unavailable`, cap hit | older raid parses are still being collected |
| nothing `unavailable`                  | no message; this is as complete as it gets  |
| rate limited with work outstanding     | collection is paused and will resume        |

This is a different signal from `research: "gathering"`, which covers character
discovery. A dossier can have finished discovering and still be filling in
parses, so both are needed.

It must be able to clear. A notice that never disappears trains people to
ignore it; `not_applicable` is what lets it clear honestly, once nothing is
`unavailable`.

Carry it in the existing `limitations` array rather than a new surface. Whether
the notice is per-dossier or per-raid is deferred; per-raid is more precise and
more interface work.

## Considered and rejected

**Limiting collection concurrency.** Rejected on evidence: collection is
already serial. pg-boss `batchSize` defaults to 1, the queue wrapper does not
override it, and the worker loop awaits its handler before fetching again:

```js
const jobs = await this.fetch();
if (jobs) {
  await this.onFetch(jobs);
}
```

A 35-minute `queueWaitMs` in the worker logs is the signature of a serial
queue. Warcraft Logs limits on request volume, not concurrency, so pacing
already-serial work would change nothing. Scoping and continuation reduce
volume instead.

**A cross-run hourly request budget**, as Blizzard fingerprint sweeps use
(`fingerprint_sweep_reservations`, `recordRequest`). This is the right shape if
proactive limiting is ever needed — stopping before Warcraft Logs pushes back,
rather than discovering the limit by hitting it. Deferred until scoping and
continuation have been measured; they may make it unnecessary.

## Rollout

Existing rows are all `unavailable` regardless of whether they were attempted,
so the first pass after deployment re-requests some fights that turn out to have
no rank. This self-corrects after one cycle. It warrants an evidence-version
bump rather than arriving quietly.

Note that a bump forces a full sweep of every character, which is what exhausted
the Warcraft Logs budget on 2026-09-16. Deploy this when the upstream limit has
recovered, and not alongside another bump.

## Testing

- `not_applicable` is recorded when a report is fetched and a fight has no
  ranking row; `unavailable` survives only where no request was made.
- `reserve()` admits a continuation when in-window kills are `unavailable` and
  the previous run hit the cap, and returns `fresh` once they are not.
- A continuation run issues no report-scan requests.
- Hydration completes in-window raids before older ones.
- The backfill notice appears while work is outstanding and clears when only
  `not_applicable` remains.

Repository behaviour is integration-tested against Postgres; gateway ordering
and scan-skipping are unit-tested against a fake fetch, following the existing
tests in `packages/warcraftlogs/src/client.test.ts`.

## Open questions

- Per-raid or per-dossier backfill notice.
- Whether a continuation should be admitted on every read, or no more than once
  per interval, so an open dossier page cannot drive continuous collection.
