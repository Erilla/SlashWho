# Provisional dossier membership while a new root is researched

## Problem

Searching a character that has never been a dossier root queues a full
discovery run rooted at it. On Railway test on 2026-09-26, eu/silvermoon/ryun
took 105 seconds (90 of them in the Blizzard fingerprint sweep), and the page
showed Ryun alone for the whole run. Yet Ryun was already a Raider.IO-claimed
member of Ryii's snapshot, published an hour earlier, holding the same ten
characters.

A direct visit to the same URL already reads that containing snapshot (#153),
but roots the view at the snapshot's own root (Ryii) and re-runs Ryii's
discovery. The search path never reads it, because the page only fetches the
root-only `?scope=initial` view while a job is active.

## Decision

A searched character without a snapshot of its own is shown, straight away,
with the membership of the newest snapshot that lists it as a
Raider.IO-declared member (`claimed` or `declared_main`), chosen only from each
root's latest completed snapshot. Superseded snapshots are never deleted, so
a claim a newer discovery dropped must not be borrowed, and the source is
filtered before the newest is chosen. The view is rooted at
the searched character, its research state is `provisional`, and the
character's own discovery still runs and replaces the view when it publishes.
Both entry points behave the same.

- **Only a declared membership is borrowed.** A `fingerprint` or `profile_guess`
  membership is not enough to show another root's whole list under the
  searched character's name; that case falls back to the root-only view.
- **Only the snapshot's characters are borrowed.** Manual connections and
  exclusions are read for the searched character, never the borrowed root:
  an exclusion is scoped to the dossier it was made in.
- **The searched character leads.** It takes the borrowed snapshot's `input`
  role; the borrowed root becomes a `claimed` member. Both labels remain
  `raiderio_declared` on the reviewer surface, as before.
- **Nothing is stored.** The borrowed snapshot is re-rooted in memory for one
  read. Snapshots stay immutable, and a character's own snapshot, once it
  exists, always wins.

## Contract

`research.state` gains `provisional`. It is distinct from `gathering`, which
means evidence is still collecting and may accompany any dossier. The page
uses `provisional` as its signal to start the character's own research on a
direct visit, and the evidence-gathering message never replaces it.

## Page

- **With an active job** (arrived from search), the page issues the full read
  alongside the fast `?scope=initial` read. The existing sequence guards let the
  full read replace the initial view; a `409 discovery_not_ready` is ignored.
  This also keeps a stale root's previous snapshot on screen while it
  refreshes, instead of dropping to root-only.
- **On a direct visit**, a `provisional` response starts research for the
  visited character. `start` joins an active run instead of adding one.

## Out of scope

- Making the fingerprint sweep faster: #549.
- The Raider.IO guild-rankings cache miss after a web restart.
