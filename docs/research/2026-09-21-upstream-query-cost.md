# Upstream query-cost reduction research

Issue #384. Investigated 2026-09-21 against `origin/main` at `2bdd8a4d`.

## Decision

Prioritise **Warcraft Logs collection convergence and reuse**. It is the only
provider with a measured per-run points bill, and history scanning is its
dominant variable cost. Do not reduce the scan, parse, or Blizzard fingerprint
caps as a cost shortcut: those caps deliberately preserve partial-result
semantics, and lower caps can prevent convergence.

The next change should use the already persisted, redacted per-attempt costs to
prove that a terminal tier or a refreshed character no longer causes repeated
collection. It should then supersede the closed #334's unresolved
non-convergent visitor-scan boundary. Raider.IO ranking caching and Blizzard
sweep accounting already remove the large repeatable costs visible in the
current implementation; improve their measurement before changing their
freshness policies.

## Evidence and baseline

All counts below mean upstream HTTP requests unless noted. Credentials,
identities, URLs, payloads, achievement fingerprints, and report codes are
intentionally omitted.

| Provider / operation       | Current bounded baseline                                                                                                                                                                      | What is measured                                                                                                                                                                                                                                                                   | Cost and correctness constraint                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warcraft Logs history scan | Up to 500 ten-report pages for worker credentials; allowance-derived cap for visitor credentials; `light` refresh is one page.                                                                | A matched live pair measured about **20 points/page** (66 pages / 1,531 points and 134 pages / 2,894 points); budget sizing deliberately uses **30 points/page**. Scan work was 58–89% of sampled spend and ranged 32–190 pages.                                                   | It establishes the stored kill set. A truncated scan is explicitly partial; declaring unscanned history complete would hide kills.                                  |
| Warcraft Logs parse work   | Default cap 24; each report-ranking hydration and each zone-ranking query is counted separately.                                                                                              | Fitted estimate is **13.2 points/request** (about 317 points at cap 24). Best parses changed from roughly 16 per-character history requests to one per `(character, zone)`; a historic character with 353 reports demonstrates why per-report best-parse hydration does not scale. | Exact first-kill parses require report-level data. Zone ranking is only a character best, never evidence for a particular fight.                                    |
| Raider.IO discovery        | Discovery uses a 12-request cap. One gateway span may hide several HTTP requests: character/profile traversal can issue multiple calls.                                                       | Existing structured records contain gateway spans, not physical HTTP counts.                                                                                                                                                                                                       | Declared ownership and profile-guess traversal are discovery evidence; caching or eliding a failed/hidden read must retain its typed limitation.                    |
| Raider.IO rank enrichment  | One logical guild/raid rank lookup is two parallel HTTP reads (rank table plus guild encounter confirmation); application cache is bounded and 15 minutes.                                    | Existing cache records hit/miss/shared/failure/capacity; recent cold dossier samples had p95 23.6 and maximum 25 ranking keys. A shared load under-attributes provider time.                                                                                                       | The confirmation read is required because the rank table includes unfinished attempts. A cached rank must never be presented as a later confirmed kill.             |
| Blizzard fingerprint sweep | Up to 300 profiled requests per admitted sweep; 28,800 hourly shared budget. A guild roster can cost profile + cached class list + roster, then each candidate achievement profile costs one. | Persistent reservation/request events and `discovery_run` records retain reserved and used counts. A live sweep observed 23 unreadable candidates out of 393; a separate real run spent all 300 requests in about 2.5 minutes and still produced a partial one-character snapshot. | Roster and fingerprints remain memory-only; any cache must not persist or expose fingerprint material. Cap exhaustion must remain an explicit partial snapshot.     |
| Blizzard Cutting Edge      | One character achievement-profile read per dossier subject, separate from the sweep. Static achievement/Journals are generated artefacts, not dossier-time reads.                             | Per-request measurement and bounded achievement cache outcomes are available; there is no physical-HTTP baseline by endpoint.                                                                                                                                                      | Achievement privacy/delay means a miss is unknown, not a negative claim. Do not reuse fingerprint responses as dossier evidence without an explicit privacy review. |

Sources in this repository:

- `packages/application/src/applicant-evidence-job-handler.ts` contains the
  measured WCL page and parse figures, allowance-derived scan cap, and the
  per-query-type counters persisted by the evidence attempt.
- `packages/warcraftlogs/src/client.ts` fixes report pages at ten because the
  nested query otherwise exceeds WCL's 50,000-point complexity ceiling, and
  performs the scan, zone and report-hydration work separately.
- `docs/research/2026-09-17-warcraft-logs-zone-rankings.md` records the live
  zone-ranking result and its history-independent request shape.
- `packages/raiderio/src/client.ts` shows the two-call guild rank confirmation;
  `packages/application/src/bounded-cache.ts` documents its TTL/LRU and
  in-flight coalescing behaviour.
- `packages/blizzard/src/client.ts`, `packages/domain/src/fingerprint-discovery.ts`,
  and `packages/application/src/blizzard-fingerprint-adapter.ts` establish the
  per-profile sweep accounting and memory-only fingerprint boundary.

Provider authorities:

- Warcraft Logs documents `rateLimitData`, character/report data and its
  GraphQL schema at [API documentation](https://www.warcraftlogs.com/api/docs)
  and [CharacterData](https://www.warcraftlogs.com/v2-api-docs/warcraft/characterdata.doc.html).
- Raider.IO publishes its supported v1 contract at
  [swagger.json](https://raider.io/swagger.json). The guild-ranking endpoint
  used for precise rank enrichment is a strict-schema-validated website
  endpoint, not a documented v1 contract; see the existing source note.
- Blizzard documents the profile and static endpoints in its
  [WoW Profile API](https://community.developer.battle.net/documentation/world-of-warcraft/profile-apis)
  and [WoW Game Data API](https://community.developer.battle.net/documentation/world-of-warcraft/game-data-apis).

## Ranked recommendations

| Rank | Candidate                                                                                                                                                                                                                                                          | Expected saving                                                                                                                                                                                                          | Freshness / correctness risk and required guard                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Make a truncated history scan settle the fully observed newest prefix, then resume below that point (a new issue superseding closed #334).                                                                                                                         | For a visitor capped at 18 pages, removes re-reading the same newest **180 reports** on every attempt; saving approaches 18 scan requests (roughly 360 measured, 540 conservative points) per otherwise unchanged retry. | High semantic risk. Persist a proved scan boundary only after a cleanly decoded page; never mark tiers below an uncertain or failed page terminal; retain `request_cap` for the unobserved remainder.                |
| 2    | Re-key Raider.IO rank reuse at `(region, realm, guild, raid)` if an A/B measurement confirms that a dossier asks several bosses for the same guild/raid; preserve the existing 15-minute TTL and coalesce across replicas only if credential boundaries permit it. | A guild with **N** boss lookups can fall from **2N to 2** HTTP reads. At the observed 25-key maximum, the upper bound is 50 reads before reuse, but the actual saving must be measured.                                  | Medium. Cache normalized successful confirmation only; do not cache a transient failure as success or let a cached rank override a changed/missing confirmed defeat. Visitor credential caches must remain isolated. |
| 3    | Use persisted terminal-tier, hydrated-fight and zone timestamps as the eligibility gate for a light refresh; do not enqueue collection when every collection domain is terminal/fresh.                                                                             | Eliminates the one-page light scan plus any residual parse/zone requests for a fresh, fully settled character. Exact saving is one to 1 + parse-cap requests per avoided run.                                            | Medium. Terminal state is domain-specific: a parse limitation must not suppress kill scanning, and a scan limitation must not make any tier terminal. Recheck after a new kill/window/catalogue change.              |
| 4    | Add a redacted cost report grouped by query class and result (`history_scan`, `fight_parses`, `zone_rankings`, `ranking_identities`) before tuning WCL caps/reserves.                                                                                              | No direct saving; turns the existing sampled costs into a defensible tuning baseline and detects regressions.                                                                                                            | Low. Keep it aggregated per evidence attempt; do not log report codes, character identities, request documents, tokens, or raw responses. Count physical gateway query classes, not just high-level spans.           |
| 5    | Correct Blizzard static-class caching to be region-keyed, with a patch-bound refresh; keep per-character achievements and sweep profiles live/accounted.                                                                                                           | Avoids a repeated static read and prevents a cross-region class-name mix-up; no material saving in the 300-request candidate loop.                                                                                       | Low for static data, high if extended to profiles. Never persist fingerprints or repurpose them as Cutting Edge evidence.                                                                                            |

## Rejected shortcuts

- Lowering `EVIDENCE_REQUEST_CAP`, `EVIDENCE_PARSE_REQUEST_CAP`, or the
  Blizzard sweep cap lowers spend by omitting collection. It violates the
  issue's completeness constraint and can create a permanent retry loop.
- Removing Raider.IO's second guild-confirmation call can assign a boss rank to
  an unfinished attempt. The two calls are not redundant.
- Caching a Blizzard achievement absence as a negative result can turn profile
  privacy or eventual consistency into a false claim that the character did
  not earn Cutting Edge.
- Expanding concurrency does not reduce provider cost. For WCL it can make
  before/after point deltas non-attributable; the queue is intentionally serial
  around that measurement.

## Follow-up implementation issues

1. **Supersede closed #334: Resume a capped Warcraft Logs history scan below a
   persisted, proved boundary.** Include migration-safe boundary semantics,
   retries, and tests showing the same newest page is not re-read after a
   clean cap stop.
2. **Add an operator-only evidence-cost report.** Aggregate persisted attempt
   cost by request class/outcome and configuration version; make the report
   explicitly redact identities and secrets.
3. **Measure and coalesce Raider.IO guild rank reads.** Add physical-call and
   fan-out counters, then share a successful `(region, realm, guild, raid)`
   confirmation under the existing TTL without crossing visitor credentials.
4. **Fix Blizzard static-cache scope and provenance.** Key class data by
   region; version generated catalogue/class/media data with retrieval time
   and release refresh policy; explicitly exclude character profiles and
   fingerprint material.

## Verification plan

Before changing a limit, capture at least 20 runs each for cold collection,
stale refresh, warm read, capped visitor collection and Blizzard sweep. Compare
p50/p95/max points, physical query-class counts, cap/limitation rate, cache
outcomes and time-to-settled evidence. Use the existing redacted evidence-cost
rows and `pnpm analyze:performance`; never attach provider credentials,
identities, request bodies, raw payloads or fingerprints to the issue.
