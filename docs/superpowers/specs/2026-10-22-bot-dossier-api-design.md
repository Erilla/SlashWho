# Bot-facing dossier API under `/api/v1` — design

**Status:** draft for review. Implements Erilla/SlashWho#916.

**Goal.** One authenticated, bot-only API so the Discord bot can create a single
dossier from every character an application named, poll it cheaply, and read a
chat-sized summary that costs no provider budget.

**Non-goals.**

- No webhooks, callbacks or push notifications.
- No change to the public `/api/dossiers` contract, payload or read path.
- No Discord id, BattleTag, message id, application id or client IP is stored,
  logged or returned.
- No Chinese-region support (#86).
- No confidence scoring from SlashWho. See decision 1.

## What already exists

- `classifyCaller` (`packages/application/src/auth.ts`) already classifies a
  valid `Authorization: Bearer <BOT_API_KEY>` as `bot`, and throws
  `unauthorized` for a wrong key. A missing header falls through to the trusted
  client-IP path and returns `anonymous`, which v1 must refuse.
- The rate limiter already has a bot search bucket
  (`BOT_SEARCHES_PER_HOUR`, default 60) and a read bucket
  (`PUBLIC_READS_PER_MINUTE`, default 300), both keyed by a hashed bot bucket.
- `ApplicantDossierService` assembles the public dossier, including the
  applicant-sheet links labelled "From application".
- `manual_dossier_connections.origin` is `dossier` or `applicant_sheet`.
- A manual connection stores the _connected_ side by key, so that side may not
  exist yet. The **root** side is still a foreign key to `characters`.
- Fingerprint-derived membership intentionally stores no score or confidence
  (`CONTEXT.md` — Source label; the fingerprint discovery spec, line 192).

## Decisions to sign off

1. **Confidence is null in v1.** The issue asks for the fingerprint confidence
   the bot currently shows. SlashWho does not retain one: the fingerprint is
   ephemeral and snapshot membership stores no score, by explicit design. The
   summary will carry `confidence: number | null`, always `null`, with a
   doc comment and a contract test. This keeps the bot's boundary stable
   without inventing a number. Shipping a real score means changing discovery
   and snapshot storage, which is a separate issue.
2. **Links before the root exists.** `manual_dossier_connections.root_character_id`
   references `characters`, and a character row is created when a snapshot
   publishes. A create that linked immediately would silently write nothing for
   a new root. We will add a small `characters.ensure` store, populated from the
   Raider.IO profile the root search already reads, before any link is written.
   No pending-link table and no worker change.
3. **`snapshotId` is API-only.** The public dossier schema has no snapshot id.
   The summary and status expose the current root snapshot's id (or the borrowed
   declaring snapshot's id when the root has none of its own). The public
   payload stays unchanged.
4. **Summary reads use stored evidence only.** The issue requires reads to spend
   no provider budget. The public read can call Blizzard for Cutting Edge and
   Raider.IO to restore missing historic ranks, and can reserve evidence runs.
   The bot summary assembles from stored evidence: no evidence reservation, no
   live Cutting Edge read, no rank restore. It may therefore lag a public read
   by one collection; the bot calls `/refresh` when it wants more.
5. **Status is a lightweight projection.** It reads the current snapshot,
   active evidence runs and the latest completed run per subject; it does not
   assemble the dossier. A test asserts its `state` agrees with the summary's
   `state` for representative collecting, ready and partial fixtures.
6. **A new `bot` origin.** Bot links are `origin = 'bot'` with no foreign key.
   The public dossier maps both `applicant_sheet` and `bot` to
   `origin: "application"`, so reviewers still read "From application".

## Endpoints

All under `/api/v1`, all Bearer-only. A missing or invalid key is
`401 unauthorized`; the anonymous client-IP fallback is never used on these
routes.

| Call                                                       | Request                                    | Response                                                                           |
| ---------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `POST /api/v1/dossiers`                                    | `{ "characters": ["<raider.io url>", …] }` | `202` or `200` with `{ root, state, snapshotId, lastCollectedAt, evidenceRunIds }` |
| `GET /api/v1/dossiers/{region}/{realm}/{name}/status`      | optional `If-None-Match`                   | `{ state, snapshotId, lastCollectedAt, evidenceRunIds, etag }`; `304`              |
| `GET /api/v1/dossiers/{region}/{realm}/{name}`             | optional `If-None-Match`                   | summary; `304`                                                                     |
| `POST /api/v1/dossiers/{region}/{realm}/{name}/characters` | `{ "characterUrl": "<url>" }`              | `200 { kind: "linked", jobId? }`                                                   |
| `POST /api/v1/dossiers/{region}/{realm}/{name}/refresh`    | —                                          | `{ mode, lastCollectedAt }`                                                        |

### `POST /api/v1/dossiers`

- 1–50 character URLs. The first is the root.
- Parse every URL with `parseRaiderIoCharacterUrl` before doing anything.
  One invalid URL fails the whole request with `400 invalid_character_url`
  and queues nothing.
- Resolve the root profile through Raider.IO (the existing search read).
  A missing root is `404 character_not_found`; an upstream failure is `503`.
- `characters.ensure` writes the root row from that profile.
- Start the root search, which reserves one search from the bot's 60/hour
  bucket, then write one `bot` link per other character and start each
  character's search, one reservation each. A link is written even when that
  character's search is suppressed or not found: it is the applicant's
  statement, and the dossier will show it as pending.
- A replay joins each active run and writes no link (the link is a no-op), so
  no second discovery run is queued.
- A `429` after some characters have been processed is possible. The links
  already written stay; retrying the same create is idempotent. This is
  documented rather than hidden behind an all-or-nothing reservation.
- Returns `200` when the root already has a fresh snapshot, `202` otherwise.
  `state` is `collecting` until a snapshot exists.

### `GET .../status`

Small body, no dossier assembly:

- `state`: `collecting` when there is no snapshot or any active evidence or
  discovery run for the dossier's keys; `partial` when the latest completed
  runs are partial; `ready` otherwise.
- `snapshotId`: the current root snapshot, or the borrowed declaring snapshot.
- `lastCollectedAt`: the oldest `completed_at` among the latest completed runs,
  matching the summary's definition.
- `evidenceRunIds`: the active runs, so the bot can see collection moving.
- `etag`: hash of the body without the etag. `304` on `If-None-Match`.
- A character that has never been searched is `404 character_not_found`.

Status and summary reads reserve from the read bucket, never the search bucket.

### `GET /api/v1/dossiers/{region}/{realm}/{name}`

Returns the summary. A dossier with no snapshot yet is **`200` with
`state: "collecting"`** and empty lists, not an error. This avoids the
`404`/`409` ambiguity in the consumer issue and means the bot only publishes
when `state` is `ready` or `partial`.

Summary shape, derived from the assembled stored dossier:

```jsonc
{
  "root": { "region": "eu", "realm": "kazzak", "name": "raasta" },
  "state": "ready",                 // collecting | ready | partial
  "snapshotId": "…",                 // null before the first snapshot
  "lastCollectedAt": "2026-10-22T09:45:52.977Z",
  "characters": [
    { "key": { … }, "displayName": "raasta", "className": "Shaman",
      "guild": { "name": "Spilled Coffee", "region": "eu", "realm": "kazzak" },
      "source": "submitted", "confidence": null, "evidenceState": "complete" }
  ],
  "guildHistory": [
    { "guild": { … }, "firstNight": "2026-01-18", "lastNight": "2026-10-11",
      "raidNights": 7,
      "raids": [
        { "raidName": "The Venomous Abyss", "kills": 7,
          "firstKillAt": "2026-09-05T18:26:29.653Z",
          "lastKillAt": "2026-10-09T21:09:30.000Z",
          "cuttingEdge": false, "characters": [ … ] }
      ],
      "characters": [ … ] }
  ],
  "raids": [
    { "raidName": "The Venomous Abyss", "cuttingEdge": null,
      "bosses": [
        { "bossName": "Nymrissa Wavecaller", "state": "kill",
          "firstKilledAt": "2026-09-05T18:26:29.653Z",
          "characters": [ … ], "worldRank": 1724,
          "reportUrl": "https://www.warcraftlogs.com/reports/…" }
      ] }
  ],
  "cuttingEdges": [ { "achievementName": "Cutting Edge: Midnight Falls",
                      "completedAt": "…" } ],
  "limitations": [ { "code": "history_limit", "affects": "kill_history",
                     "character": { … } } ]
}
```

Projection rules:

- Excluded characters are omitted, as they are from the dossier's evidence.
- `guildHistory` is derived from every stored Mythic kill: a guild per entry,
  UTC kill dates for nights, and one stint per raid with its first and last
  kill, kill count, Cutting Edge flag and character keys. It is not the
  existing `guildHistory` nights list, which does not carry raids.
- `raids` keeps bosses whose state is `kill` or `wipe`, for raids with at least
  one kill. `no_logs` and `incomplete` bosses are omitted: they are chat noise
  and dominate the payload. A raid with no kills is omitted.
- `characters` inside guild history and bosses are character keys, not prose.
- `confidence` is always `null` (decision 1).
- `bestWipePercent` is omitted: no stored evidence carries a wipe percentage,
  and a field that is always null says less than its absence.
- `limitations` keeps `code`, `affects` and the character key; the prose
  `message` and recovery policy are web-only.
- `ETag` is the SHA-256 of the serialized summary body. `304` on a match.

The response must stay under 40 KB for the measured 2-, 5- and 8-character
samples. The 1.7 MB demo dossier (`apps/web/src/app/demo/ryii-dossier.json`)
gives a real 5-character projection to measure; an 8-character synthetic case
is built from it in a unit test.

### `POST .../characters`

- Validates the URL, then resolves the root dossier. An unknown root is `404`.
- Writes the `bot` link first and starts the character's search. An existing
  link returns `200 { kind: "linked" }` and queues nothing new.
- A rate-limited search returns `429`; the link remains, and a retry is
  idempotent.

### `POST .../refresh`

Delegates to the existing `refreshCharacter`, returns the existing
`dossierRefreshResponseSchema` shape. It is the only summary-side call that may
spend provider budget.

## Contracts

New `packages/contracts/src/bot-dossier.ts`, strict zod throughout:

- `botDossierStateSchema`
- `botDossierStatusSchema`
- `botDossierSummarySchema`
- `botCreateDossierRequestSchema` (`characters` 1–50)
- `botAddDossierCharacterRequestSchema`
- `botCreateDossierResponseSchema`
- `botAddDossierCharacterResponseSchema`

Types are re-exported from `packages/contracts/src/index.ts`. Every response is
validated with the same schema at the route boundary, as the public routes do.

`tests/fixtures/contracts/bot-client-v1.json` is rewritten to describe only
these implemented endpoints, and a contract test parses every fixture response
against its schema. The stale `/api/v1/searches` and `/api/v1/characters`
entries are removed.

## Storage and services

- **Migration 0075** widens the `manual_dossier_connections.origin` check to
  include `bot`. Additive, no backfill, no new table. Journal entry in
  `packages/database/drizzle/meta/_journal.json`.
- `ManualConnectionRepository.add` accepts
  `{ origin: "applicant_sheet"; applicationId } | { origin: "bot" }`;
  `ManualConnectionCharacter.origin` includes `bot`; `list` maps it.
- `legacyResolveSubjects` maps both `applicant_sheet` and `bot` to
  `origin: "application"` on the public dossier character.
- New `characters.ensure` store: the same upsert as the snapshot writer's
  `upsertCharacters`, extracted so both paths use one statement.
- `SearchService.resolveCharacter(key)` exposes the root profile read the
  search already performs, so create can ensure the row without a second
  Raider.IO request.
- `ApplicantDossierService` gains `readSummary(key, scope)` and
  `readStatus(key, scope)`. `assembleDossier` gains a stored-only mode that
  reads `evidence.getCompleted` per subject, uses stored Cutting Edge and stored
  historic ranks, and never schedules or calls a provider. The public read path
  is untouched.

## Auth and limits

A small `requireBot` helper wraps `classifyCaller`:

- valid Bearer key → `{ callerClass: "bot", bucketHash }`
- missing, malformed or wrong key → `401 unauthorized` (never
  `trusted_client_ip_unavailable`, never anonymous)

Creates, add-character and refresh reserve the bot search bucket once per
character. Status and summary reserve the read bucket. `429` carries
`Retry-After`, as the public routes already do.

## Failure semantics

- Invalid URL: `400`, nothing queued.
- Unknown root: `404`.
- Suppressed character: linked but not collected (`404` from its search is not
  an error for the create).
- `429`: existing bucket semantics with `Retry-After`.
- `research = partial` is a normal summary state; `limitations` explains it.
- Upstream failure: `503 upstream_unavailable`.

## Testing

- **Unit:** contracts accept/reject; summary projection (collecting, ready,
  partial, exclusions, empty); size guard on the demo dossier and an
  8-character synthetic dossier; status/summary state agreement; ETag stability
  and `304`; `requireBot` rejects missing, malformed and wrong keys.
- **Integration:** create with three characters writes three rows with
  `origin = 'bot'` and the public dossier labels each "From application";
  invalid URL queues nothing; a replayed create queues no second discovery run;
  add-character is idempotent; status and summary `304`; a stored-only summary
  with throwing provider gateways succeeds; per-character search limits apply;
  migration 0075 applies and preserves existing rows.
- **Gate:** the whole `format:check`, `lint`, `typecheck`, `test:unit`,
  `test:integration`, `build`, `test:e2e` sequence, with Docker running.

## Risks

- **Summary size.** The 40 KB ceiling is a test, not a promise. If a real sample
  exceeds it, the first lever is omitting old raids; the second is keys instead
  of repeated names.
- **Stored-only lag.** A summary read immediately after `ready` may omit a
  Cutting Edge achievement or historic rank that a live public read would
  restore. The bot can call `/refresh`; the alternative is spending provider
  budget on reads, which the issue forbids.
- **Linking before discovery.** `characters.ensure` must not race the worker's
  snapshot upsert. The upsert is keyed and `ON CONFLICT DO UPDATE`, so the last
  writer wins with the same profile data; the integration test covers a link
  written before the first snapshot.
