# Unknown-guild historic rank handling (#804)

Status: approved at `3a06e2cc` in review 5506082765; implementation in progress.

Issue: <https://github.com/Erilla/SlashWho/issues/804>

## Intent and current evidence

Unknown guilds should settle a historic rank lookup as a checked null, without
an outage limitation or a repeated lookup on every dossier read or worker run.
Real upstream failures must remain retryable and distinguishable in logs.

Fresh base: `7c21c89f33b9365defa3046724e6f94576957795` (`origin/main`).
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
   a candidate answered no-match, distinguished by a client-local marker;
   other messages, malformed JSON and other statuses retain response
   classification. A `Retry-After` response remains a throttle even if its
   body contains the literal. Never retain a response body on an error.
   Settle the rankings/profile pair with `Promise.allSettled`, using an
   abort-aware wait that rejects promptly on caller cancellation even while
   the other half is pending; remove its abort listener once finished and keep
   settlement handlers attached to both promises. Check the caller signal
   before interpreting failures: caller abort propagates
   and never becomes a limitation or answered no-match. Requests remain
   bounded by their existing timeouts. Return the final
   `{ kind: "limitation", code: "not_found", guildNotFound: true }` only when
   at least one half failed and **every failed half** carries the exact guild
   candidate marker; the other half may succeed or carry that same marker.
   Both successful halves still produce ordinary rankings.
   For mixed failures, discard candidate no-matches and choose deterministically
   from real failures: throttle first (429 or Retry-After), then transient
   HTTP/network/timeout or an unclassified throw, then schema, then private,
   then bare 404. Within an equal priority use endpoint order (rankings before
   profile), never completion order. Carry the largest `retryAfterMs` among
   throttled halves on the selected throttle result and retain its status
   classification. Bare 404 on these guild paths becomes retryable
   `unavailable` with `http_4xx` metadata, never a guild candidate.
   Other endpoint behaviour, including character 400 and 404, stays unchanged.
2. Add optional closed failure metadata to `MythicBossRankingsResult` and the
   client limitation mapping: `not_found`, `http_4xx`, `http_5xx`, `timeout`,
   `network`, `schema`, `throttled`, `private`. Distinguish client timeout from
   network failure without exposing error messages. 429 or Retry-After keeps
   its throttling semantics. Local/schema validation uses `schema`. Add
   optional literal `guildNotFound?: true` to the rankings limitation result;
   only the fully settled guild pair may emit it. Do not add this marker to
   generic upstream failure types or unrelated evidence results.
3. In `historic-ranks.ts`, only `code === "not_found"` together with
   `guildNotFound === true` is an answered lookup with empty rankings: record
   a null rank and checked-at, return null, and add no dossier limitation.
   Generic `not_found` without the marker stays a limitation and never writes
   a checked null. Bare guild-path 404 is an `unavailable` limitation and remains
   retryable; neither the web nor worker may settle it. Keep actual outages and
   the 50-key read cap unchanged. A failed write-through remains readable and
   is retried by a later read.
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
   Increment once in the requesting facade's catch path, after
   `signal?.throwIfAborted()`: caller cancellation propagates **uncounted**.
   A `RankingLookupFailure` uses its closed client metadata (or a closed
   legacy code mapping when metadata is absent). A catch-all timeout abort,
   including the client rethrow of the gateway's `PROVIDER_TIMEOUT_MS` signal
   reason, returns `unavailable` with `timeout` metadata and increments
   `raiderIoRankingsFailureTimeout`. Identify the timeout via the closed
   `TimeoutError` name, never the message. Any other unwrapped rejection
   returns `unavailable` with `network` metadata and increments
   `raiderIoRankingsFailureNetwork`. No new negative-cache behaviour is
   required for raw thrown gateway errors; returned limitations retain the
   existing cache rules. Catch-path accounting also covers cache replay,
   shared waiters and visitor overrides without charging the load owner twice.
5. In the worker ranking phase, add a named **seven-day** null-rank re-check
   interval. A stored numeric rank remains final. A stored null with a valid
   recent checked-at skips lookup; missing/invalid/future timestamps are due.
   A recent null means `0 <= now - checkedAt < 7 * 24 * 60 * 60_000`; at the
   exact interval boundary the worker re-asks. Read checks from
   `storedEvidence.parseOnlyKills`, matched by `fightUrl`, and use a single
   clock value for this phase. A skipped kill emits no new checked-at; database
   merge's `kill.historicRankCheckedAt ?? storedCheck` preserves the original
   stamp. Only newly answered `not_found` with `guildNotFound === true`
   contributes empty rows, stamps checked-at/null, and does not make the phase
   limited. Bare 404 and generic unmarked `not_found` make no checked-null
   write and keep the phase limited. Other failures and request caps keep their
   current phase semantics.

The optional renamed-guild lookup is omitted: it needs a separate matching
decision and is unnecessary to meet the required acceptance criteria. No WCL
queries, budgets, concurrency, character-group interfaces or HTTP cache policy
change. Dossier responses stay `Cache-Control: no-store`.

## Test-first implementation sequence

- [x] Client fixtures: test each recorded response with the other guild endpoint
      returning success and the pair together; all classify as marked guild
      not found. Use controlled deferred responses for literal-then-503 and
      503-then-literal, plus literal/429 with `Retry-After` in both completion
      orders; assert identical outage/throttle results and preserved delay.
      Test both real halves failing, including two throttle delays and equal
      priority tie-breaking by endpoint. Test bare 404 HTML with success and
      with the guild literal: unavailable/http_4xx, no marker. Test unrelated
      400/422, malformed JSON, exact-message mismatch, literal with Retry-After,
      timeout and caller abort while the other half is pending. Keep the existing
      unknown-character test unchanged. Commit the minimal client change.
- [x] Web fallback: test checked null write-through, absence of a limitation,
      second read from persisted evidence with no gateway call, failed writes,
      and a mixed no-match/outage dossier. Assert no numeric zero is introduced.
      For bare-404 unavailable/http_4xx and generic unmarked not_found, assert
      no recordLookup call, a limitation, and lookup on the next read.
      Implement and commit the fallback change.
- [x] Gateway/logging: test negative-cache replay and TTL expiry, independent
      concurrent read scopes, mixed failures and visitor overrides. Exercise
      timeouts through the actual gateway timeout signal passed to a client
      fake: rejection becomes one timeout counter on the requesting scope.
      Also cover an arbitrary raw rejection as network, and caller cancellation
      both before load and while waiting: propagate with no failure counter.
      A shared load timeout must increment each waiting scope once; no extra
      count on the original scope. Confirm cached bare-404 failures do not
      acquire the guild marker or stamp checks after replay.
      Extend the web logger allowlist and its exact-field coverage; test serialised
      `http_request` contains closed numeric fields and no URL, guild name or
      upstream body. Retain the response no-store regression test. Commit.
- [x] Worker: test new no-match stamps null and completes, a recent null check
      makes no request, the exact seven-day boundary re-checks and can resolve
      a rank, missing/invalid/future timestamps re-check, and outages remain
      limited. Recent checks must come from storedEvidence.parseOnlyKills by
      fightUrl, not from a newly fetched kill. Assert bare-404 and unmarked
      not_found results do not stamp checked-at, remain limited, and are asked
      again on a later eligible run. Verify a skipped checked null emits no new
      stamp and publication preserves the original via database merge coverage.
      Commit.
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
- Review amendments address PR #908 review 5506013878: deterministic pair
  settlement, explicit answered-guild marker versus bare 404, and gateway
  catch-all timeout/network counters with uncounted caller abort. Seven days
  and per-class counters were agreed in that review; implementation still
  received approval in review 5506082765.

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
