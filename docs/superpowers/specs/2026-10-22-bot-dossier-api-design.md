# Bot-facing dossier API under `/api/v1` — design

**Status:** revised for review. Implements Erilla/SlashWho#916.

**Goal.** One authenticated, bot-only API so the Discord bot can create a single
dossier from every character an application named, poll it cheaply, and read a
chat-sized summary that costs no provider budget.

**Non-goals.**

- No webhooks, callbacks or push notifications.
- No change to the public `/api/dossiers` contract, payload or read path.
- No Discord id, BattleTag, message id, application id, client IP, key or raw
  request URL is stored, logged or returned.
- No Chinese-region support (#86).
- No confidence scoring from SlashWho. See decision 1.

## What already exists

- `classifyCaller` (`packages/application/src/auth.ts`) classifies a valid
  `Authorization: Bearer <BOT_API_KEY>` as `bot` and throws `unauthorized` for a
  wrong key. A missing header falls through to the trusted client-IP path and
  returns `anonymous`, which v1 must refuse.
- The rate limiter has a bot search bucket (`BOT_SEARCHES_PER_HOUR`, default 60)
  and a read bucket (`PUBLIC_READS_PER_MINUTE`, default 300), both keyed by a
  hashed bot bucket.
- `ApplicantDossierService` assembles the public dossier, including
  applicant-sheet links labelled "From application".
- `manual_dossier_connections.origin` is `dossier` or `applicant_sheet`.
- A manual connection stores the _connected_ side by key, so it may not exist
  yet. The **root** side is a foreign key to `characters`.
- `manualConnections.list` filters the connected side against
  `suppressed_characters` (`packages/database/src/small-stores.ts:142-149`).
  A link to a suppressed character is written and then omitted from every
  dossier read.
- `evidence.getCompleted` (`packages/database/src/evidence/load.ts:39-62`) has
  no suppression filter, while `snapshots.getCurrent` does
  (`packages/database/src/snapshots.ts:74-81`).
- Fingerprint-derived membership intentionally stores no score or confidence
  (`CONTEXT.md` — Source label; the fingerprint discovery spec, line 192).

## Decisions

1. **Confidence is null in v1.** SlashWho does not retain a fingerprint score.
   The summary carries `confidence: number | null`, always `null`, with a doc
   comment and a contract test. The contract says the bot must not infer a score
   from it. This is a deliberate, flagged exception to `CONTEXT.md`'s Source
   label ("no confidence value is retained alongside it") and its `Avoid:
Confidence` line: the field is a forward-compatible placeholder, carries no
   value, and does not amend the domain model. A real score is a separate
   discovery/storage change.
2. **Links are written only after the search is accepted.** `search.create`
   checks suppression before reading Raider.IO and returns the profile it read
   on the queued path. Create writes `characters.ensure` and the `bot` link
   only after that acceptance, so a `429`, a suppressed root or a `not_found`
   root writes nothing. The fresh-root path reads no profile at all because a
   fresh snapshot already implies its `characters` row.
3. **A suppressed target is skipped, not linked.** `manualConnections.list`
   hides suppressed connected characters, so a written link would silently
   disappear. Create and add-character check suppression first and report the
   character as `suppressed`; no row is written. The summary and status also
   filter suppressed subjects explicitly, because `evidence.getCompleted` has
   no suppression filter of its own.
4. **Summary reads use stored evidence only.** The summary assembles from
   `evidence.getCompleted`: no reservation, no live Blizzard Cutting Edge read,
   no Raider.IO rank restore, no publish, no repair, no queue. `cuttingEdge:
null` means "not restored by this read", never "not earned". If no stored
   evidence exists for a subject, the state says `collecting` rather than
   pretending the dossier is complete.
5. **One bot `state`, shared by status and summary.** It is a separate
   projection from the public `research.state`. `research.state` is derived
   from the borrowed-snapshot flag and the snapshot's own state, and is
   overridden to `gathering` while evidence gathers; it can say `partial`
   forever for a privacy-hidden snapshot. The bot projection is run-based and
   is defined once in the next section, so status and summary cannot disagree.
   The public dossier keeps its existing meaning.
6. **`snapshotId` is the publish gate.** The bot publishes only when status and
   summary both say `ready` or `partial` **and** both carry the same non-null
   `snapshotId`. A snapshot publishing between the two reads is detected by the
   mismatch and the bot re-reads.
7. **A new `bot` origin.** Bot links are `origin = 'bot'` with no foreign key.
   The public dossier maps both `applicant_sheet` and `bot` to
   `origin: "application"`, so reviewers still read "From application". This
   extends `CONTEXT.md`'s **Manual connection** definition to a declaration the
   bot recorded rather than the sheet watcher; `CONTEXT.md` is updated to say
   so.
8. **At most 10 declared characters per create.** A maximum create spends 10 of
   the bot's 60 searches an hour, leaving 50 for retries and later calls. The
   applicant sheet's own cap is lower (root plus four). The bot's existing
   `429` pause/resume covers a bucket that is already spent.

## Bot `state` (source of truth)

Both routes call one helper with these inputs:

- the **own** root snapshot (`snapshots.getCurrent`), or null;
- whether a discovery run is active for **any** included subject
  (`runs.findActiveMany`, not `runs.findActive(root)`: the root's run alone is
  not enough);
- the active evidence-run ids for the dossier's subjects;
- each included subject's latest terminal run (`complete` or `partial`) and its
  `completed_at`. A **pending manual connection** — a declared character with
  no snapshot and no terminal run — is an included subject whose terminal run
  is absent, so it keeps the dossier `collecting` until it settles;
- the payload limitations, including the `request_cap` recorded for a subject
  past `DOSSIER_CHARACTER_CEILING`.

Rules, in order:

1. No own snapshot → `collecting`.
2. A discovery run or any evidence run is active → `collecting`.
3. Any included subject has no terminal run → `collecting`.
4. The own snapshot's state is `partial` (for example `privacy_hidden`), or any
   terminal run is `partial`, or the payload carries any limitation → `partial`.
5. Otherwise → `ready`.

A subject with an active evidence run is `scanning`, including a pending link
that is being collected; one with no run and no terminal result is `waiting`.
A borrowed declaring snapshot never counts as the own snapshot, so a character
whose own discovery is still running is `collecting`, not a provisional
`ready`. This deliberately differs from `research.state`; the public dossier is
unchanged.

`lastCollectedAt` is the oldest `completed_at` among those latest terminal runs,
matching the public dossier's definition, or null before any run. `snapshotId`
is the own snapshot's id, or null until it exists; a borrowed snapshot's id is
never used. `evidenceRunIds` are the active evidence runs.

## Endpoints

All under `/api/v1`, all Bearer-only. A missing, malformed or wrong key is
`401 unauthorized`; the anonymous client-IP fallback is never used.

| Call                                                       | Request                                          | Response                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `POST /api/v1/dossiers`                                    | `{ "characters": ["<raider.io url>", …] }`, 1–10 | `200`/`202` create result with per-character outcomes; `429` only when the root is limited |
| `GET /api/v1/dossiers/{region}/{realm}/{name}/status`      | optional `If-None-Match`                         | `{ state, snapshotId, lastCollectedAt, evidenceRunIds, etag }`; `304`                      |
| `GET /api/v1/dossiers/{region}/{realm}/{name}`             | optional `If-None-Match`                         | summary; `304`; `200 collecting` once the dossier is known                                 |
| `POST /api/v1/dossiers/{region}/{realm}/{name}/characters` | `{ "characterUrl": "<url>" }`                    | `200`/`202` linked, or `429`                                                               |
| `POST /api/v1/dossiers/{region}/{realm}/{name}/refresh`    | —                                                | `{ mode, lastCollectedAt }`                                                                |

**Existence and suppression.** A key is _known_ when its `characters` row
exists, it is not suppressed, and it has a snapshot or a discovery/evidence
run. Create ensures the root row only after a search is accepted, so a created
dossier is always known. Status and summary return `404 character_not_found`
for an unknown key and for a suppressed key, so a removal request stops the bot
polling. Create and add-character return `404 suppressed_character` when the
root or target is suppressed, before any write; that is where the bot learns
the removal request applies. The two codes are deliberate: reads do not confirm
that a suppressed character exists.

### `POST /api/v1/dossiers`

- Parse every URL with `parseRaiderIoCharacterUrl` before doing anything. One
  invalid URL fails the whole request with `400 invalid_character_url` and
  queues nothing.
- Start the root search first. `search.create` checks suppression and returns:
  - `not_found` → `404 character_not_found`;
  - `suppressed_character` → `404 suppressed_character`;
  - `rate_limited` → `429` with the root's outcome and `Retry-After`;
  - `job` (with the profile it read) or `character` (fresh) → accepted.
- On acceptance, `characters.ensure` writes the root row from the returned
  profile (a no-op when the fresh path already has one). `ensure` is an
  `INSERT … ON CONFLICT DO NOTHING`, so it never lowers a class or level the
  snapshot wrote.
- For each other character, in order: start its search; only when accepted,
  write the `bot` link with `ON CONFLICT DO NOTHING`. The link is written on
  **every** accepted character, including a replay whose search joined an
  existing run: if the process died between the enqueue and the link write, the
  retry sees `existing` and must still write it, or the character never joins
  the dossier. A `429`, `not_found` or `suppressed` target is recorded and
  **not** linked, so no link is left pending forever. A link to an existing
  `applicant_sheet` or `dossier` row is never relabelled.
- **Duplicate URLs are deduplicated** by canonical key, preserving first
  position, and charged once. A duplicate of the root is not linked: there is
  never a self-link. The response has one outcome per unique character.
- Response:

  ```jsonc
  {
    "root": { "region": "eu", "realm": "kazzak", "name": "raasta" },
    "state": "collecting",
    "snapshotId": null,
    "lastCollectedAt": null,
    "evidenceRunIds": [],
    "outcomes": [
      { "key": { … }, "outcome": "queued", "jobId": "…" },
      { "key": { … }, "outcome": "existing" },
      { "key": { … }, "outcome": "rate_limited" }
    ],
    "retryAfterSeconds": 17
  }
  ```

  `outcome` is `queued | existing | rate_limited | suppressed | not_found |
failed`. `retryAfterSeconds` is present only when some character was limited.
  The HTTP status is `200` only when every character's outcome is `existing`;
  otherwise `202` when anything was queued, skipped, suppressed or limited. Any
  `failed` outcome makes the response `503`, **with the same body** and the
  failing characters marked `failed` — there is no separate error envelope,
  because the bot needs to know which characters failed. A partial create still
  returns `202` with the limited characters named, so the bot can show "queued
  3 of 10" and retry only the rest.

- Replaying the create joins each active run (`existing`) and writes no link, so
  no second discovery run is queued. A `429` at character 4 leaves the first
  three queued and reports the rest truthfully; the retry is the same create
  with `existing` outcomes for the first three.

### `GET .../status`

Small body, DB-only, no provider calls:

- `state`, `snapshotId`, `lastCollectedAt`, `evidenceRunIds` from the shared
  state helper.
- `etag`: SHA-256 of the body without the etag. `304` on `If-None-Match`.
- Every response, including a `304`, keeps `Cache-Control: no-store`. The ETag
  is a conditional-read validator, not permission to store the payload.
- `404 character_not_found` for an unknown or suppressed key.
- Reserves the read bucket, never the search bucket.

### `GET /api/v1/dossiers/{region}/{realm}/{name}`

Returns the summary. Once the key is known, a dossier with no own snapshot yet
is `200` with `state: "collecting"` and empty lists; an unknown or suppressed
key is `404` (the same answer as status). This removes the earlier 404-versus-
200 disagreement for one key.

Summary shape:

```jsonc
{
  "root": { "region": "eu", "realm": "kazzak", "name": "raasta" },
  "state": "ready",                 // collecting | ready | partial
  "snapshotId": "…",                 // null before the own snapshot exists
  "lastCollectedAt": "2026-10-22T09:45:52.977Z",
  "cuttingEdgesRestored": true,      // false when stored evidence cannot say
  "characters": [
    { "key": { … }, "displayName": "raasta", "className": "Shaman",
      "guild": { "name": "Spilled Coffee", "region": "eu", "realm": "kazzak" },
      "source": "submitted", "confidence": null, "evidenceState": "complete",
      "pending": false }
  ],
  "guildHistory": [
    { "guild": { … }, "firstNight": "2026-01-18", "lastNight": "2026-10-11",
      "raidNights": 7, "tiers": ["The Venomous Abyss"],
      "characters": [ … ],
      "raids": [
        { "raidName": "The Venomous Abyss", "kills": 7,
          "firstKillAt": "2026-09-05T18:26:29.653Z",
          "lastKillAt": "2026-10-09T21:09:30.000Z",
          "characters": [ … ] }
      ] }
  ],
  "raids": [
    { "raidName": "The Venomous Abyss",
      "bosses": [
        { "bossName": "Nymrissa Wavecaller", "state": "kill",
          "firstKilledAt": "2026-09-05T18:26:29.653Z",
          "characters": ["eu/kazzak/raasta"], "worldRank": 1724,
          "reportUrl": "https://www.warcraftlogs.com/reports/…" }
      ] }
  ],
  "raidsTruncated": false,           // older raids with kills were dropped
  "cuttingEdges": [ { "achievementName": "Cutting Edge: Midnight Falls",
                      "completedAt": "…" } ],
  "limitations": [ { "code": "history_limit", "affects": "kill_history",
                     "character": { … } } ]
}
```

Projection rules:

- Suppressed and excluded characters are omitted, as they are from the
  dossier's evidence.
- `characters[].evidenceState` uses the public enum
  `waiting | scanning | complete | partial`. A **pending** manual connection —
  a declared character with no snapshot and no terminal run — is `waiting`,
  with `className` and `guild` null, `displayName` the normalized key name,
  `source: "manually_added"`, `confidence: null` and `pending: true`. A
  character with a snapshot but no evidence is also `waiting`, with
  `pending: false`. `scanning` means an evidence run is active for it.
- `guildHistory` is built from `collectGuildRaidNights` and
  `guildTimelineSpans` (`packages/domain/src/guild-history.ts`), the same rules
  as the page: a UTC calendar day is a raid night, renames merge through
  `guildIdentity`, a guild seen on a single night is dropped as a pug
  (`MINIMUM_GUILD_NIGHTS = 2`), and a span splits only when a whole tier passes
  between nights. Each entry is a **span**, not a guild. A character with kills
  in two guilds appears in both; a night with kills in both counts for each.
  The span's `tiers` are the span's tier names.
- Each span's `raids` are the stored kills in that span and guild, grouped by
  raid. `kills` counts **distinct kill events** — a boss at one moment is one
  event however many roster rows name it — and `characters` unions the
  `region/realm/name` identities on those events. There is no Cutting Edge on a
  stint: stored Cutting Edge is account-wide and carries no guild or raid.
- Top-level `raids` keeps bosses whose state is `kill` or `wipe`, for raids with
  at least one kill, ordered by **latest activity** (newest first) and capped at
  the five most recent such raids. `raidsTruncated: true` says older raids with
  kills were dropped. `no_logs` and `incomplete` bosses are omitted. Boss
  `characters` are `region/realm/name` identities; the top-level `characters`
  list carries the full key, and two same-named characters on different realms
  stay distinct. There is no per-raid `cuttingEdge`: the domain never sets it,
  so the account's achievements in `cuttingEdges` are the only Cutting Edge
  claim.
- `cuttingEdgesRestored` is true only when every included subject has stored
  evidence whose Cutting Edge was collected. When false, `cuttingEdges` is an
  incomplete list, not a statement that none exist.
- `bestWipePercent` is omitted: no stored evidence carries a wipe percentage.
- `limitations` keeps `code`, `affects` and the character key; the prose
  `message` and recovery policy are web-only. A `privacy_hidden` snapshot adds
  `{ "code": "privacy_hidden", "affects": "linked_characters" }` so a partial
  state is never explained by an empty list.
- `ETag` is the SHA-256 of the serialized summary body. `304` on a match. The
  status ETag covers only the four status fields, not the summary; suppressing a
  non-oldest character can change the summary while `state`, `snapshotId`,
  `lastCollectedAt` and `evidenceRunIds` stay the same.

The response must stay under 40 KB for the measured 2-, 5- and 8-character
samples. The 1.7 MB demo dossier (`apps/web/src/app/demo/ryii-dossier.json`)
gives a real 5-character projection. For the 8-character case, capture a real
stored dossier during implementation if it is cheap; otherwise use a clearly
labelled synthetic expansion and record which was used.

### `POST .../characters`

- Validates the URL and the root. An unknown or suppressed root is `404`.
- If the link already exists:
  - with completed evidence → `200 { kind: "linked" }`, no search;
  - without completed evidence → start the search to resume it. `202
{ kind: "linked", jobId }` when queued, `200` when fresh, `429` when
    limited. The link is left in place. This is the retry path after a
    rate-limited create.
- If the link does not exist: start the search; only when accepted, write the
  `bot` link. A `429`, `not_found` or `suppressed` target returns the matching
  error and writes nothing.
- `{ origin: "bot" }` is `ON CONFLICT DO NOTHING`, so an existing
  `applicant_sheet` or `dossier` origin survives a second add. A test asserts
  the existing origin and the public "From application" label.
- A rate-limited search returns `429`; the retry resumes it, so the character
  cannot stay pending with no run.

### `POST .../refresh`

Delegates to the existing `refreshCharacter`, returns the existing
`dossierRefreshResponseSchema` shape: `mode` is `full` outside the character's
refresh cooldown and `light` inside it (the public refresh control's meaning).
It is the only summary-side call that may spend provider budget.

## Contracts

New `packages/contracts/src/bot-dossier.ts`, strict zod throughout:

- `botDossierStateSchema`
- `botDossierStatusSchema`
- `botDossierSummarySchema` (including `cuttingEdgesRestored` and
  `confidence: z.number().min(0).max(100).nullable()`)
- `botCreateDossierRequestSchema` (`characters` 1–10)
- `botCreateDossierResponseSchema` (with `outcomes`)
- `botAddDossierCharacterRequestSchema`
- `botAddDossierCharacterResponseSchema`

Types are re-exported from `packages/contracts/src/index.ts`; every route
validates its response with the same schema.

`tests/fixtures/contracts/bot-client-v1.json` is **rewritten**, not patched.
The stale `/api/v1/searches`, `/api/v1/characters`, history and snapshot entries
are removed; the fixture describes only the five implemented routes above. A
contract test parses every fixture response against its schema.

## Storage and services

- **Migration 0075** (`0075_bot_dossier_connections.sql`) must
  `ALTER TABLE manual_dossier_connections DROP CONSTRAINT
manual_dossier_connections_origin_check` and add the widened check including
  `'bot'`; the current check is inline on the column in `0074:45-49`. The
  journal entry is `idx: 74`, `when: 1792184400000` (strictly greater than
  `1792098000000`; recheck against `origin/main` before opening the PR). The
  migrations test pins an explicit tail, so `slice(-42)` becomes `slice(-43)`
  and the list gains `{ idx: 74, tag: "0075_bot_dossier_connections" }`.
- Every origin enumeration changes together:
  - `packages/database/src/repositories.ts:208` (`ManualConnectionCharacter.origin`);
  - `packages/database/src/repositories.ts:227` (`add` options);
  - `packages/database/src/small-stores.ts:170` (the cast);
  - `packages/application/src/dossier-subjects.ts:163` (the public label — miss
    this and bot links read "Manually added");
  - `packages/database/src/schema.ts:377` (the comment);
  - `tests/integration/repositories-dossier-connections.test.ts` and
    `tests/integration/migrations.test.ts`.
- New `characters.ensure`: `INSERT … ON CONFLICT (region, realm_slug,
normalized_name) DO NOTHING`, followed by a `SELECT` for the existing id when
  the insert returns no row (the conflict path has no `RETURNING` value). It
  never overwrites a snapshot's class, level, display name or URL, and a link
  written before the first snapshot survives that snapshot. One test pins each.
- `SearchService.create` returns the `RaiderIoCharacter` profile on the `job`
  result (internal only; the public `startResultResponse` ignores it). The bot
  create passes it to `characters.ensure` after acceptance, so the fresh path
  adds no Raider.IO read and the stale path reads once.
- `ApplicantDossierService` gains `readStored(key, scope)` and
  `readStatus(key, scope)`. `readStored` returns the stored dossier and its
  evidence; `botDossierSummaryOf` projects it to the bot contract. `assembleDossier` gains a stored-only mode that:
  - reads `evidence.getCompleted` per subject with an explicit
    `suppressions.isActive` check before each subject and alias;
  - uses stored Cutting Edge and stored historic ranks only;
  - never schedules, publishes, repairs or queues;
  - returns the evidence metadata the shared state helper needs.
    The public read path is untouched.

## Auth and limits

A `requireBot` helper wraps `classifyCaller`: a valid Bearer key returns the
bot identity; a missing, malformed or wrong key returns `401 unauthorized`
(never `trusted_client_ip_unavailable`, never anonymous).

Creates and add-character are charged by the search they start: one search per
character that queues or joins a run. A path that settles on an already-fresh
snapshot, or on an existing link with completed evidence, spends no provider
work and is not charged. Refresh charges through a gate that runs after the
light-refresh skip decision and immediately before the reservation, so a settled
light refresh costs nothing. Status and summary reserve the read bucket only
after the key is known to exist, so a suppressed or unknown key is a `404` even
when the bucket is exhausted and a retry costs no read token. `429` carries
`Retry-After`.

## Failure semantics

- Invalid URL: `400`, nothing queued.
- Unknown key: `404 character_not_found`.
- Suppressed root/target at create or add: `404 suppressed_character`, nothing
  written. Suppressed key at status/summary: `404 character_not_found`.
- `429`: existing bucket semantics with `Retry-After`; a partial create returns
  `202` with per-character outcomes and a `retryAfterSeconds`.
- `research = partial` is a normal summary state; `limitations` explains it.
  `cuttingEdge: null` and `cuttingEdgesRestored: false` mean the stored read
  could not restore it.
- Upstream failure: `503`. On a create, the 503 carries the create body with
  the failing characters marked `failed`; elsewhere it is
  `503 upstream_unavailable`.

## Testing

- **Unit:** contracts accept/reject; summary projection (collecting, ready,
  partial, exclusions, empty); `guildHistory` spans (one-night pug dropped,
  rename merged, tier gap split, multi-guild character, no per-stint
  `cuttingEdge`); `cuttingEdge`/`cuttingEdgesRestored` semantics; the 40 KB
  guard on the demo and the 8-character case; the shared state helper across
  no-snapshot, discovery-active, evidence-active, partial-run, privacy-hidden
  and borrowed-snapshot fixtures; ETag stability and `304`; `requireBot` rejects
  missing, malformed and wrong keys.
- **Integration:** create links every accepted character with `origin = 'bot'`
  and the public dossier labels each "From application"; a suppressed target is
  skipped and reports `suppressed` with no row; an invalid URL queues nothing;
  a fresh-root create makes no Raider.IO call; a stale/new root reads once and
  ensures after acceptance; replay queues no second discovery run and still
  writes a missing link; a partial `429` reports per-character outcomes;
  add-character resumes a link with no evidence and queues exactly one search;
  an existing `applicant_sheet` link keeps its origin; `ensure` after a
  snapshot does not lower class/level and a link written before the snapshot
  survives; **create three characters, publish only the root's snapshot, and
  assert the dossier stays `collecting` because the two pending links have no
  terminal run**; status and summary agree on `state` and `snapshotId`; a
  suppressed subject is omitted from the stored-only summary; migration 0075
  applies and preserves existing origins.
- **Gate:** the whole `format:check`, `lint`, `typecheck`, `test:unit`,
  `test:integration`, `build`, `test:e2e` sequence, with Docker running.

## Risks

- **Summary size.** The 40 KB ceiling is a test, not a promise. The first lever
  is omitting old raids; the second is keys instead of repeated names.
- **Stored-only lag.** `cuttingEdge: null` and `cuttingEdgesRestored: false`
  are the honest signals; the bot can call `/refresh`. Spending provider budget
  on reads is what the issue forbids.
- **Status cost.** The shared state helper reads the same subject list as the
  summary to guarantee agreement. It is DB-only but not a single query; if poll
  volume ever makes it matter, cache or narrow the subject read without
  changing the definition.
- **Linking before discovery.** `characters.ensure` is `ON CONFLICT DO
NOTHING`, so it cannot race the worker's snapshot upsert into lowering a
  known class or level. The link survives the snapshot because snapshots do not
  touch `manual_dossier_connections`.
