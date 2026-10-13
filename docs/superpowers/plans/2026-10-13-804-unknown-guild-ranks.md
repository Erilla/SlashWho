# Unknown-guild historic rank handling (#804)

Status: proposed; implementation awaits Manager review on the draft PR.

Issue: <https://github.com/Erilla/SlashWho/issues/804>

## Intent and current evidence

Unknown guilds should settle a historic rank lookup as a checked null, without
an outage limitation or a repeated lookup on every dossier read or worker run.
Real upstream failures must remain retryable and distinguishable in logs.

Fresh base: `7c21c89f33b9365defa3046724e6f94576957795` (`origin/main`).
Worktree: `G:/repos/SlashWho/.claude/worktrees/fix-804-unknown-guild-ranks`.
Branch: `fix/804-unknown-guild-ranks`.

The relevant flows still exist on current main: the web fallback only records
successful rankings; the worker only skips stored numeric ranks; the gateway
negative-caches only `unavailable`; the client collapses HTTP status into that
code. No migration is needed: null ranks and checked-at are already stored.

Two live, unauthenticated requests were made outside the PR gate on 13 October
2026, using a synthetic nonexistent guild on a valid EU realm and mapped raid.
No credential was used. Only the sanitised envelope and error body are retained
in `tests/fixtures/recorded/raiderio/`:

- `guild-rankings-unknown-guild.json`: `/api/guilds/raid-rankings`, HTTP **422**.
- `guild-profile-unknown-guild.json`: `/api/v1/guilds/profile`, HTTP **400**.

Both bodies say exactly `Could not find requested guild`. The issue's proposed
400-only fix would miss the rankings endpoint. This plan therefore covers both
400 and 422, restricted to these two guild paths and that exact message.
Character endpoint classification remains unchanged.

## Proposed design

1. In `packages/raiderio/src/client.ts`, inspect an unsuccessful 400/422 JSON
   body only on the two guild endpoint paths. The exact guild message becomes
   `not_found`; other messages, malformed JSON and other statuses retain the
   existing response classification. Never retain a response body on an error.
   Keep abort propagation and throttle handling intact.
2. Add optional closed failure metadata to `MythicBossRankingsResult` and the
   client limitation mapping: `not_found`, `http_4xx`, `http_5xx`, `timeout`,
   `network`, `schema`, `throttled`, `private`. Distinguish client timeout from
   network failure without exposing error messages. 429 or Retry-After keeps
   its throttling semantics. Local/schema validation uses `schema`.
3. In `historic-ranks.ts`, treat `not_found` as an answered lookup with empty
   rankings: record a null rank and checked-at, return null, and add no dossier
   limitation. Keep actual outages and the 50-key read cap unchanged. A failed
   write-through remains readable and is retried by a later read.
4. In `dossier-gateways.ts`, negative-cache `not_found` using the existing TTL.
   Report failures through the requesting measurement scope, including cache
   replay and shared waiters. Use a closed mapping to allowlisted numeric
   fields `raiderIoRankingsFailureNotFound`, `raiderIoRankingsFailureHttp4xx`,
   `raiderIoRankingsFailureHttp5xx`, `raiderIoRankingsFailureTimeout`,
   `raiderIoRankingsFailureNetwork`, `raiderIoRankingsFailureSchema`,
   `raiderIoRankingsFailureThrottled`, `raiderIoRankingsFailurePrivate`.
   Each is a count of logical failed answers received by that read, not physical
   calls; existing physical-call fields remain the way to measure upstream cost.
   Counters preserve every failure class when one read has mixed failures and
   require no generic string-setting API or ambient logging callback.
5. In the worker ranking phase, add a named **seven-day** null-rank re-check
   interval. A stored numeric rank remains final. A stored null with a valid
   recent checked-at skips lookup; missing/invalid timestamps are due. At the
   interval boundary the worker re-asks. Match stored kills by fight URL as
   current code does. A newly answered `not_found` contributes empty rows,
   stamps checked-at/null, and does not make the phase limited. Other failures
   and request caps keep their current phase semantics. Preserve the stored
   check when carrying evidence through publication.

The optional renamed-guild lookup is omitted: it needs a separate matching
decision and is unnecessary to meet the required acceptance criteria. No WCL
queries, budgets, concurrency, character-group interfaces or HTTP cache policy
change. Dossier responses stay `Cache-Control: no-store`.

## Test-first implementation sequence

- [ ] Client fixtures: test each recorded response with the other guild endpoint
      returning success; both classify as not found. Test unrelated 400/422,
      malformed JSON, exact-message mismatch, 429, 503, timeout and abort. Pin
      existing unknown-character behaviour. Commit the minimal client change.
- [ ] Web fallback: test checked null write-through, absence of a limitation,
      second read from persisted evidence with no gateway call, failed writes,
      and a mixed no-match/outage dossier. Assert no numeric zero is introduced.
      Implement and commit the fallback change.
- [ ] Gateway/logging: test negative-cache replay and TTL expiry, independent
      concurrent read scopes, mixed failures and visitor overrides. Extend the
      web logger allowlist and its exact-field coverage; test serialised
      `http_request` contains closed numeric fields and no URL, guild name or
      upstream body. Retain the response no-store regression test. Commit.
- [ ] Worker: test new no-match stamps null and completes, a recent null check
      makes no request, the exact seven-day boundary re-checks and can resolve
      a rank, invalid timestamps re-check, and outages remain limited. Verify
      publication preserves skipped checks with database merge coverage. Commit.
- [ ] Run the full gate with Docker running: `corepack pnpm format:check`,
      `lint`, `typecheck`, `test:unit`, `test:integration`, `build`, `test:e2e`.
      Self-review against `origin/main`; fetch and merge current `origin/main`
      and run the full gate again before making the PR ready for review.

Each task starts with a failing regression test, then the minimal code change,
then a passing focused suite. All commands use `corepack pnpm`. Implementation
runs in this chat and this worktree. Never merge or enable auto-merge.

## Review decisions

- Confirm handling the recorded **422** as well as 400 for the exact guild
  literal; other errors must remain transient.
- Confirm seven days as the bounded worker re-check policy for checked nulls.
- Confirm per-class numeric failure counts on `http_request` instead of one
  failure string, so mixed failures are measurable without arbitrary log data.

## Deployment acceptance hand-off

After Manager merge and deployment, coordinate read-only measurements on Railway
test. Post before/after evidence on #804: web rankings duration, cache failures
and per-class failure counts; ryun's Raider.IO outage limitations; and the
worker rankings phase completed/limited split over seven days. Record sample
windows and deployment SHA. Use the issue's baseline as historical evidence,
and obtain a current pre-deployment baseline where access permits. A seven-day
after window cannot be claimed complete immediately after deployment. Local
tests do not satisfy this acceptance item. Credentials or disruptive operations
require a concrete reviewed coordinator hand-off.
