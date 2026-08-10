# Achievement-Fingerprint Discovery Design

**Date:** 2026-08-10

**Status:** Approved for implementation planning; privacy boundary amended
2026-08-10 (see below)

## Amendment: the privacy-hidden exclusion was removed

Everything below describing privacy-hidden Raider.IO ownership as a reason to
exclude a root or a candidate from fingerprint discovery **no longer describes
the system**. The maintainer removed both exclusions after implementation: the
condition available in code (`ownerId === null`) cannot distinguish a player who
withheld the link from a character never claimed on Raider.IO at all, and it was
skipping the latter — the majority of characters, and the population the sweep
exists to reach.

The consequences accepted with that decision: a fingerprint-derived link may now
connect characters whose Raider.IO ownership is not public, reversing
[Privacy stance on defeating hidden ownership](https://github.com/Erilla/SlashWho/issues/8)
and the mitigation
[Data-protection exposure for publishing derived account linkage](https://github.com/Erilla/SlashWho/issues/16)
identified as the one that materially moves the UK GDPR balancing and necessity
tests. Manual removal requests are the only remaining exclusion route. The
`/privacy` page was rewritten to state this rather than the old promise.

## Summary

SlashWho will extend its existing durable `discover-character` job with Blizzard
achievement-fingerprint discovery. The job keeps Raider.IO discovery as its first
phase, then—when a root character is eligible—uses the root's current Blizzard
guild roster as the initial candidate source. It compares each candidate's
achievement completion timestamps with the root's in memory and folds accepted
matches into the same immutable snapshot as Raider.IO relationships.

This is one deployable feature. Public search, character, history, and snapshot
API shapes do not change. Fingerprint-derived and Raider.IO-declared characters
appear in one undifferentiated alt list. The implementation persists neither
achievement fingerprints nor scores, timestamps, achievement IDs, raw Blizzard
responses, access tokens, or credentials.

The design records the decisions in the completed
[achievement-fingerprint map](https://github.com/Erilla/SlashWho/issues/4).

## Goals

- Automatically discover same-account characters from Blizzard achievement
  completion data during eligible searches.
- Begin candidate enumeration with the root character's current Blizzard guild
  roster.
- Preserve the existing immutable-snapshot and durable-worker contracts.
- Bound Blizzard use with a FIFO, shared rolling budget of 28,800 requests per
  hour and a configured per-sweep request cap.
- Reuse the existing public character and search API without exposing discovery
  provenance, confidence, queue state, or budget information.
- Exclude privacy-hidden ownership from fingerprint-derived linkage, using
  Raider.IO as the sole privacy signal.
- Keep all achievement material ephemeral to one in-memory sweep.

## Non-goals

- Candidate sources beyond the root's current guild roster, including guild
  history, raid-log collection, and a global guild index.
- Cross-region matching or China-region matching; Blizzard's relevant Profile
  API does not support the latter, and fingerprints are not comparable across
  regions.
- Persisting achievement IDs, timestamps, signatures, match scores, raw bodies,
  access tokens, or user-supplied Blizzard credentials.
- A public match score, source badge, queue indicator, or operational budget
  display.
- Stable Blizzard character IDs. Rename/transfer continuity remains a deferred
  standalone effort ([#27](https://github.com/Erilla/SlashWho/issues/27)).
- Tracing `Ictinus` to `Mistakinus`; that is a separate investigation
  ([#24](https://github.com/Erilla/SlashWho/issues/24)).

## Terminology

This design uses the project terms recorded in `CONTEXT.md`:

- **privacy-hidden ownership** is Raider.IO's intentionally non-public ownership
  state and the only privacy signal used for inferred links;
- **fingerprint-derived link** is a relationship inferred from Blizzard
  achievement completion data;
- **alt list** is the public, provenance-free relationship list;
- **partial snapshot** is an immutable result known not to contain every
  discoverable relationship; and
- **ephemeral fingerprint** is achievement data held only for one sweep and
  discarded before publication.

## Architecture

`discover-character` remains the only durable job and only snapshot writer. Its
phases become:

1. Run the existing Raider.IO traversal and produce its transient relationship
   observations.
2. Determine whether the root is eligible for a fingerprint sweep. A root is
   eligible when no successfully published fingerprint sweep has occurred in
   the previous seven days.
3. When eligible, enter the shared Blizzard admission queue. The job waits in
   FIFO order for capacity; it does not fail a user search or occupy a worker
   execution while waiting.
4. At admission, reserve the full configured sweep cap against the shared,
   rolling 28,800-request/hour budget. No Blizzard request begins before this
   reservation succeeds.
5. Fetch the root guild roster and root achievement data, then fetch and compare
   candidates until the cap is reached or the roster is exhausted.
6. Merge accepted fingerprint-derived characters with the Raider.IO observations
   and atomically publish one snapshot.

The job has no separate public API, snapshot type, or completion state for the
fingerprint phase. A completed cap-bounded sweep is a successful partial
snapshot with the internal limitation `fingerprint_sweep_capped`. A successful
sweep with no guild or an empty roster is a measured result with no
fingerprint-derived additions.

## Blizzard integration and matching

The worker obtains a client-credentials access token using the operator-managed
`BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET`. It uses Blizzard's regional
Profile API to resolve the root's current guild and roster, then fetches
achievement completion data for the root and each roster candidate.

An ephemeral fingerprint maps achievement IDs to their completion timestamps.
For a same-region candidate, the matcher counts common achievement IDs and the
subset whose timestamps are identical. It accepts a candidate only when both
conditions hold:

- at least 200 achievement IDs are common; and
- at least 20% of those common IDs have identical completion timestamps.

The accepted candidate contributes only its ordinary character fields and an
internal `fingerprint` discovery source to the combined snapshot membership.
Scores and the comparison inputs are discarded immediately after each candidate
is evaluated. No fingerprint may cross a job boundary or survive publication.

Before a fingerprint-derived character is admitted to snapshot membership, the
worker applies the existing Raider.IO privacy-hidden ownership check. A
privacy-hidden candidate is excluded from fingerprint discovery. Raider.IO
relationships continue to follow Raider.IO visibility as they do today.

## Freshness, queueing, and budget accounting

Raider.IO retains its existing 24-hour refresh model. Fingerprint discovery is
decoupled: a root may successfully run at most one sweep every seven days.

When a root is due, the first search that creates or refreshes its discovery run
causes the fingerprint phase to be queued. Later searches for that root reuse
the same active run. While an eligible sweep waits or runs, the existing current
snapshot remains visible. Public responses do not state that a fingerprint sweep
is due, queued, admitted, or running.

The system persists only operational state required to enforce this policy:

- per-root successful fingerprint-sweep time and the active/queued run
  reference;
- an internal terminal reason for the sweep; and
- a Blizzard-budget reservation ledger containing run identity, reserved count,
  accounting window, and release/expiry state.

The ledger is updated transactionally when capacity is reserved. Used requests
remain charged to the rolling window. Unused reserved capacity is released when
the sweep finishes or aborts. A retryable failure releases only unused capacity;
it never erases the usage already consumed. Only successful snapshot publication
advances the seven-day eligibility window.

All values are validated worker configuration: client credentials, sweep cap,
hourly budget (initially 28,800), identical-timestamp percentage (initially
20), common-achievement floor (initially 200), and sweep cadence (initially
seven days).

## Snapshot and failure semantics

A fingerprint sweep is atomic. Its roster, candidate list, fingerprints,
comparison results, and progress cursor exist only in process memory.

- Reaching the configured request cap publishes the allowed partial snapshot and
  ends the sweep. A later eligible run starts again from the root; it does not
  resume a cursor or reuse a candidate list.
- A transport failure, 429, 5xx, malformed response, schema drift, process
  abort, or deployment shutdown before publication discards all in-memory sweep
  state and leaves the prior snapshot current.
- Retryable failures use the existing bounded exponential-backoff path. A retry
  restarts the whole atomic job from the root.
- Graceful shutdown stops beginning new Blizzard requests, abandons an unfinished
  sweep before the existing drain deadline, and relies on a later retry instead
  of extending deployment draining.
- A no-guild or empty-roster response is a successful measured sweep. Unsupported
  region coverage is an explicitly recorded internal limitation rather than an
  unmeasured failure.

Snapshot membership stores no score or confidence. It may retain the existing
internal discovery-source field for diagnostics, extended with `fingerprint`;
the shared serializers continue to omit this field from every public response.

## Observability and privacy

Structured logs and internal metrics record only operational information:

- FIFO queue depth and admission wait time;
- per-caller admission;
- per-sweep cap reservation versus actual request use;
- rolling shared-budget commitment;
- retry and failure accounting; and
- sweep duration and final internal limitation class.

The worker alerts a maintainer when admission has been blocked for 15 minutes,
reserved capacity exceeds 90%, or Blizzard returns a 429 response. No log,
metric, public response, or alert includes credentials, tokens, raw response
bodies, achievement IDs, timestamps, scores, or per-character comparison data.

The `/privacy` page documents that privacy-hidden Raider.IO ownership excludes
fingerprint-derived links. There is no separate SlashWho opt-out mechanism.

## Testing strategy

Unit tests cover:

- fingerprint extraction and comparison, including both threshold boundaries;
- privacy-hidden exclusion;
- root-guild-roster candidate ordering and no-guild/empty-roster outcomes;
- request-cap and rolling-budget accounting;
- seven-day eligibility and active-run reuse; and
- every classification of success, partial result, failure, abort, and retry.

PostgreSQL integration tests prove that concurrent sweeps cannot over-reserve
the shared rolling budget, waiting sweeps are admitted FIFO, duplicate searches
reuse one root run, only successful publication advances cadence, cap-bounded
runs publish an allowed partial snapshot, and aborted/retried runs neither
persist fingerprint material nor replace the prior snapshot.

Worker integration tests use sanitized Blizzard fixtures for token acquisition,
no guild, empty roster, successful matches, 429 responses, transport failures,
and schema drift. Existing API and browser tests continue to prove that public
payloads and character pages reveal neither provenance nor queue/budget state.

Staging acceptance uses the operator-managed credentials to complete a small,
known public eligible sweep within its configured cap and shared-budget
reservation. It must find known eligible matches, create no sensitive retained
fingerprint material, and leave the public API shape unchanged.

## Acceptance criteria

The feature is ready for staging validation when:

1. An eligible search automatically queues one fingerprint sweep for its root;
   later searches reuse it.
2. The worker uses the current root guild roster, only compares same-region
   candidates, and accepts only the approved 20%/200 threshold.
3. Privacy-hidden ownership never produces a fingerprint-derived public link.
4. The worker cannot begin a sweep without first reserving its whole configured
   cap within the shared rolling budget.
5. A cap-bounded sweep publishes one partial snapshot with an internal
   `fingerprint_sweep_capped` reason; all other interruption paths preserve the
   previous snapshot.
6. A successfully published sweep suppresses another sweep for that root for
   seven days, while daily Raider.IO refresh behavior remains intact.
7. Database, worker, API, and browser tests prove that no raw or compact
   fingerprint material, score, or public provenance is retained or exposed.
8. Internal alerts fire for the agreed queue-blocked, 90%-reservation, and 429
   conditions.
