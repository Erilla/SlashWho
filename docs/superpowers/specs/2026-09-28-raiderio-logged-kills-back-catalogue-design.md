# Raider.IO-logged first kills in settled tiers

Follows #732 (PR #734). Found in #734's final review.

## Problem

`historicTierOrdinalsFrom` (`packages/application/src/verified-kills.ts`)
leaves out every Raider.IO tier whose raids all closed before the character's
kill-scan floor. That was right while Raider.IO's kill list was only a search
hint (#298): whatever such a tier returns is below the floor, which is never
searched, or a kill made after its raid's content window closed.

Since #732 the kill list also carries `loggedEncounterId`, and a logged first
kill is evidence. For a character with settled older tiers, those tiers are
never asked again, so their logged kills never reach the
`raiderio_logged_encounters` phase, not even once. #734's merge carries such
kills forward, but nothing ever collects them. A veteran applicant keeps "No
qualifying public logs found" on old bosses that Raider.IO has a logged kill
for.

There is a second gap of the same shape. A tier that was read while current and
has since settled is never asked again either, so its stored rosters are never
re-read. If a guild later hides its compositions, the dossier keeps naming
its raiders, which #732's re-read rule exists to stop.

## Decision

Each character asks each settled tier's kill list **once**, at one Raider.IO
request per tier and no Warcraft Logs points. After that, the phase rebuilds
the tier's kills from the character's own stored first kills, so their rosters
keep being re-read by the existing rules without asking for the kill list
again.

Nothing else about #732 changes. Only parsed fields are stored, never
`log.sources` or a raw response. A partial result never removes kill evidence.
The 50-read cap, the concurrency, the rate-limit handling and the rule that no
shortfall schedules a whole-run retry all stand.

## Design

### 1. Asking a settled tier once

- **A new table, `character_raiderio_tier_reads`** (migration `0067`; renumber
  if another lands first): `region`, `realm_slug`, `normalized_name`,
  `tier_ordinal`, `collection_version` and `read_at`, keyed by the character
  and `tier_ordinal`.
- **Its own collection version.** `CURRENT_RAIDER_IO_TIER_READ_VERSION = 1`
  sits beside `CURRENT_COLLECTION_VERSIONS` in
  `packages/database/src/evidence/freshness.ts`, with the same contract: a
  collection fix to Raider.IO first kills bumps it, and every settled tier is
  asked once more. A mark below the current version is not read back.
- **It is not a new `evidence_collection_domain`.** `character_terminal_tiers`
  is keyed by Warcraft Logs raid id, and every `CASE domain … ELSE tier_bests`
  in its SQL would have to learn a fourth value. A separate table has the same
  effect without touching the terminal-tier paths.
- **`historicTierOrdinalsFrom` takes the marked tiers.** A tier is left out
  only when both hold:
  - every raid it answers for closed before the floor, as today;
  - it has a mark at the current version.

  Everything else about it stands: no floor, or a floor that can't be read,
  keeps every tier, and the last pinned tier is always kept.
- **The repository** gains `raiderIoTierReads(key)`, which returns the marked
  ordinals at the current version, and
  `markRaiderIoTierReads(key, ordinals, at)`, which upserts the version and
  `read_at`. If the marks can't be read, they are treated as none: that costs
  a few Raider.IO requests, never a kill.

### 2. When a tier is marked

The handler marks the tiers asked this run **only because they had no mark**:
every raid of theirs closed before the floor. It writes the marks after
`publish` commits, and only when:

- the kill list came back whole (the client already reports any failed tier as
  a limitation of the whole list); and
- `raiderio_logged_encounters` had no shortfall (`collected.limitation` is
  null), so every logged kill the list named now has a stored answer and has
  been presence-checked.

A capped, rate-limited or failed phase marks nothing. The tier is asked again
next run, and the next 50 reads drain its backlog, as #732's backlog does. A
tier is marked all or nothing for the run, whichever tier the shortfall came
from: that keeps the rule simple, and a persistent shortfall only costs a few
repeated tier requests. A mark written before `publish` commits could leave a
tier unasked with its kills unpublished, so marks always come after. A failed
mark write never fails the run: the tier is just asked again.

A rebuild (`clearTerminalTiers`) leaves these marks alone. With no terminal
tier there is no floor, so every tier is asked anyway, and the marks are still
true once a floor returns.

### 3. Re-reading kills in settled tiers

- **The phase gets the settled kills.** When the kill list was read, every
  stored first kill in a raid the run did not ask about is rebuilt as a
  Raider.IO kill: `raidSlug`, `bossSlug`, `firstDefeated` from the stored
  `killedAt`, the stored kill-list guild, and `loggedEncounterId`. These go
  into `collectRaiderIoFirstKills` alongside the run's own kills.
- **Only re-reads.** A stored answer already covers each of them, so none is a
  first read. They are read again only under #732's rules:
  - a visible roster, once the guild's `shareRaidUntil` has passed, or after
    30 days where Raider.IO named no end;
  - a private roster, after 7 days;
  - a permanent refusal, after 30 days.

  They share the 50-read cap and queue behind first reads, as re-reads already
  do.
- **They count as asked.** Their raid slugs join `askedRaidSlugs`, so
  `mergeRaiderIoFirstKills` treats them exactly as an asked raid:
  - a re-read that finds the roster hidden turns it private;
  - a roster that opens is presence-checked like any new read, and a complete
    publish drops the kill if the character's Raider.IO id is not on it;
  - a partial publish carries everything forward;
  - a failed read never removes a kill.
- **No kill list, no rebuild.** If the run could not read the kill list,
  nothing is rebuilt and storage carries every stored first kill forward, as
  today.

A rebuilt kill with no logged encounter, or one whose permanent refusal is not
yet due, costs nothing and is published unchanged.

### 4. What does not change

- What is stored about an encounter and a roster, and what is never stored.
- The dossier read, the contract and the web interface.
- Run cost accounting: a tier request is still a Raider.IO character read and
  counts in `raiderio_historic_requests`; re-reads count in
  `raiderio_logged_encounter_requests`.

### 5. Cost

At rollout, each character with a floor asks each settled tier once: at most
16 requests, since the last pinned tier is always asked. A veteran's back
catalogue of logged kills then drains at 50 encounter reads a run, as #732's
rollout backlog does. After that, steady-state runs make no extra kill-list
requests. Re-reads of settled kills fall due at most weekly (private) or every
30 days (visible, or refused).

### 6. Testing

Every identity is synthetic. No test sends live Raider.IO or Warcraft Logs
traffic.

- **`historicTierOrdinalsFrom`:** an unmarked settled tier is kept, a marked one
  is left out, a mark at an older version is ignored, and the no-floor and
  last-tier rules are unchanged.
- **`collectRaiderIoFirstKills`:**
  - a rebuilt kill is never a first read, and is re-read only when due;
  - a due re-read that finds the roster hidden turns it private;
  - one that finds the roster visible without the character leaves the kill
    out;
  - re-reads of rebuilt kills share the cap behind first reads.
- **Job handler, with a veteran whose tier is settled:**
  - the first run asks the tier, publishes its logged kill, and marks the
    tier;
  - the second run does not ask for the tier's kill list, yet re-reads a due
    roster from it;
  - a capped phase marks nothing, the next run asks the tier again, and
    neither schedules a retry;
  - a failed kill list marks nothing and carries every first kill forward;
  - a failed mark write does not fail the run.
- **Database:** marks round-trip and are gated on the version, and the
  migrations test covers `0067`.

### 7. Documentation

- `historicTierOrdinalsFrom`'s comment gains the mark rule.
- The "Raider.IO-logged first kills" section of
  `docs/dossier-evidence-semantics.md` gains a paragraph: a settled tier is
  asked once per character; its logged kills then keep being re-read from what
  was stored, never asked for again.

## Out of scope

- Reading later kills, or Heroic and Normal kills.
- A worker-wide Raider.IO rate limiter.
- Marking each tier on its own rather than all or nothing per run.
