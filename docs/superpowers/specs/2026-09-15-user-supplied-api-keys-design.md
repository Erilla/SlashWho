# User-supplied API keys design

## Purpose

Let a visitor supply their own Blizzard, Raider.IO, and WarcraftLogs API
credentials from a settings page, so their searches use their own upstream
rate-limit budget instead of only the server's shared one. This is Phase 1 of
a two-phase effort (see issue #219); accounts/sign-in remain out of scope.

## Why this differs by provider

The three providers are not called the same way, so they cannot share one
transport:

- **Raider.IO** and **Blizzard** are called synchronously while a dossier
  request is in flight (`applicant-dossier-service.ts` calls
  `raiderio.getMythicBossRankings`, `raiderio.getCharacter`, and
  `blizzard.getCompletedAchievements` during `read`/`readInitial`). A header on
  that request can reach them directly.
- **WarcraftLogs** is only ever called from the worker's queued evidence job
  (`applicant-evidence-job-handler.ts`, driven by `character_evidence_runs`
  rows), which runs later, in a separate process, decoupled from any browser
  request. There is no synchronous request for a header to ride on.

## Settings and storage (browser)

A settings page collects, per credential:

- Blizzard Client ID + Client Secret
- Raider.IO access key
- WarcraftLogs Client ID + Client Secret

All fields are stored in `localStorage`, scoped to that browser. Nothing is
sent anywhere until the browser makes a search/dossier request.

## Transport: Blizzard and Raider.IO (synchronous path)

The browser attaches stored keys as request headers on dossier requests:

- `X-Blizzard-Client-Id`, `X-Blizzard-Client-Secret`
- `X-RaiderIO-Access-Key`

The dossier route handlers (`apps/web/src/app/api/dossiers/**/route.ts`) read
these headers and, when present, construct a per-request `BlizzardGateway`
and/or `RaiderIoGateway` (via `createBlizzardClient` /
`createRaiderIoClient`) instead of using the container's shared long-lived
gateways built from server env vars at startup. Absent headers fall back to
the existing shared gateways unchanged. Building a client is cheap (no
network call up front — both clients lazily fetch an OAuth token or just call
the REST API), so a per-request client is not a meaningful cost.

`ApplicantDossierService.read`/`readInitial` currently close over their
gateways at construction (`applicant-dossier-service.ts`). They gain an
optional per-call gateway override:

```ts
read(key: CharacterKey, options?: { signal?: AbortSignal; blizzard?: BlizzardGateway; raiderio?: RaiderIoGateway }): Promise<ReadDossierResult>
```

When an override is present the service uses it for that call only; nothing
is cached or stored beyond the call's lifetime.

These headers must never be logged, never echoed back in error responses, and
never forwarded anywhere other than the matching provider's own API/token
endpoint (carried over from issue #219's security constraint).

## Transport: WarcraftLogs (asynchronous job path)

Because the WCL call happens in a worker job created earlier by a web
request, the key must travel with the queued job row, not a header:

1. When a dossier request supplies `X-WCL-Client-Id` /
   `X-WCL-Client-Secret` and triggers evidence discovery
   (`enqueueCharacterEvidence`), those values are encrypted (server-held
   symmetric key, e.g. `EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY`) and stored on
   the new `character_evidence_runs` row (`wcl_client_id_encrypted`,
   `wcl_client_secret_encrypted`, both nullable).
2. The worker's job handler decrypts them when it claims the run and builds a
   per-run `WarcraftLogsGateway` (`createWarcraftLogsClient`), falling back to
   the worker's own server-configured `WARCRAFT_LOGS_CLIENT_ID`/`_SECRET` when
   the columns are null.
3. On any terminal state (`complete`, `partial`, `failed`) the handler
   immediately clears both encrypted columns in the same update that records
   the terminal status, so the ciphertext never outlives the run.

**Known limitation, accepted for Phase 1:** `character_evidence_runs` has one
active run per character key (`character_evidence_runs_one_active_key_idx`).
If two browsers with two different WCL keys both trigger discovery for the
same character concurrently, only the first creates a run and carries its
key; the second browser's key is not used for that run. This is a rare
collision (same character, same moment, two different visitors both missing
cached evidence) and does not need solving in Phase 1 — the run still
completes using a valid key, just not necessarily the second caller's.

## Explicitly out of scope (Phase 2, deferred)

- Accounts/sign-in.
- Durable, account-linked storage of any of these keys.
- Solving the concurrent-run key-collision limitation above (an account-scoped
  key resolved at job-claim time removes the issue entirely, since the worker
  would look up the account rather than trust the enqueuing request).

## Testing

- `applicant-dossier-service.test.ts`: per-call gateway override is honoured
  for Blizzard and Raider.IO; absent override falls back to the injected
  gateway.
- Route tests: header presence builds a per-request gateway; absent header
  behaves exactly as today.
- `applicant-evidence-job-handler.test.ts`: encrypted columns round-trip
  through claim/decrypt/build-gateway; columns are cleared on complete,
  partial, and failed terminal states, including the failure path.
- Repository/schema test: new columns exist, default null, never appear in
  any existing read path that isn't explicitly decrypting them.
- No test or log output ever contains a raw credential value (grep-based
  assertion where practical, matching the existing "keep OAuth credentials
  out of logs" invariant).

Full unit suite, lint, typecheck, format check, and a live Railway deployment
are run before handoff, consistent with other specs in this repo.
