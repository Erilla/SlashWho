# Candidate sources beyond guild rosters

**Ticket:** Erilla/SlashWho#7 — "Candidate sources beyond guild rosters"
**Date:** 2026-08-06
**Status:** Research. Surfaces and characterises options; does not design a sweep.

## Why this question is the whole feature

A fingerprint answers "are these two known characters the same account?". It never
answers "which characters should I ask about?". Reach is bounded entirely by
enumeration, and enumeration turns out to be a harder problem than matching.

SeriouslyCasualBotV2 concedes this in its own words. `discoverAlts` documents the
achievement fingerprint as the source that "always works but only sees shared
guilds" (`src/functions/applications/alts/discoverAlts.ts`, lines 97–106). Its
reach is exactly the union of the rosters it walks; nothing outside those rosters
is findable however good the matcher is.

Two consequences shape everything below:

- A source is worth its cost in proportion to the chance the account we want is
  *in* it. A million cheap characters that never overlap the target is worth
  nothing; fifty candidates chosen *because* they plausibly share an account with
  the root is worth a great deal.
- Blind spots compose badly. If every source is drawn from organised endgame
  play, the union of all of them still cannot see a levelling alt, a bank alt, or
  an unguilded character.

## Method

Primary sources throughout. Two access problems were solved rather than worked
around, and the solutions are recorded because they will be needed again:

- **Blizzard.** `develop.battle.net/documentation/*` now 301-redirects to
  `community.developer.battle.net/documentation/*`, which is an Angular SPA — a
  plain fetch returns only the shell. The portal's JS bundle declares
  `pageDataBase:"/api/pages"`, and the reference content is served as JSON from
  `https://community.developer.battle.net/api/pages/content/documentation/{path}.json`.
  That payload is what the reference page renders — endpoint name, path, HTTP
  method, namespace and full parameter list. It is the primary source, not a
  mirror. **It does not contain response schemas or sample bodies**, so every
  claim below about *what fields a response contains* is marked as inferred from
  the live API rather than doc-verified.
- **Raider.IO.** `https://raider.io/api` returns 403 to non-browser user agents
  (Cloudflare). The Swagger UI loads its spec from
  `https://raider.io/swagger.json` — Swagger 2.0, `info.version` **0.62.5**, 37
  paths. `https://raider.io/openapi.json` is an OpenAPI 3.0 rendition with a
  byte-identical path set. `https://classic.raider.io/swagger.json` is a separate,
  smaller spec (v2.0.39, 15 paths) that still carries a rate-limit figure retail
  has since dropped.

All retrievals dated **6 August 2026**. Figures marked *(estimate)* are not in
any document and should be measured before a budget depends on them.

## What SlashWho actually has today

Read from this repository at commit `8cd0ea1`.

### The corpus

`packages/database/src/schema.ts`, table `characters`: `id`, `region`,
`realm_slug`, `normalized_name`, `display_name`, `class_name`, `level`,
`raider_io_url`, `created_at`, `updated_at`.

There is exactly one index: `characters_canonical_key_idx`, a UNIQUE btree on
`(region, realm_slug, normalized_name)`. What it permits matters more than the
row count:

- **Free:** point lookup by canonical key; range scan by `region`; range scan by
  `(region, realm_slug)`. "Every character we know of on Argent Dawn" costs zero
  external requests.
- **Not supported:** by class, by level, by recency (`created_at`/`updated_at`
  are unindexed), and — the important one — **by guild. There is no guild column
  at all.** The corpus cannot seed a guild frontier without re-fetching everything.
- **Not stored, deliberately:** owner id, BattleTag, Discord handle. The MVP
  design states these "exist only in worker memory for the duration of a job and
  are neither stored nor logged"
  (`docs/superpowers/specs/2026-08-04-slashwho-mvp-design.md`). The corpus cannot
  be queried by owner, which is the one key that would make it trivially useful.
- **No read path exists.** `packages/database/src/repositories.ts` exposes
  `SnapshotRepository`, `SuppressionRepository`, `RateLimitRepository`,
  `NegativeCacheRepository` and `SearchReservationRepository`. There is no
  `CharacterRepository` and no list operation. The corpus is write-mostly,
  read-by-key.

### The already-linked set

`snapshots` and `snapshot_characters` are more interesting than `characters`. A
snapshot is a persisted, dated set of characters believed to share an account,
anchored to `root_character_id`, with per-member `discovery_source` of
`input | claimed | declared_main | profile_guess`. Co-membership in a snapshot is
**an account link already established** — not a candidate awaiting a match, but
an answer.

### The matcher SlashWho does not have

`packages/domain/src/discovery.ts` performs no fingerprinting and walks no
rosters. It is a pure Raider.IO identity walk: load the root, follow the
`declaredMain` edge once, resolve `ownerId` and pull the claimed-character list,
and when the owner is privacy-hidden try two cheap profile guesses
(`discord_profile`, then the character name). Default budget is 12 upstream
requests per job; exceeding it yields a `partial` snapshot with
`limitationCode: "request_cap"`.

**This is a hard dependency for the entire ticket.** Every source below produces
candidates, and a candidate is worthless without something to test it against.
SlashWho has no fingerprint pass, no achievement store, and no Blizzard client
credentials — the MVP design lists "Blizzard achievement-fingerprint discovery"
as an explicit non-goal. The ordering of matcher versus enumerator should be
decided on purpose, not by accident.

## Baseline: the guild-roster sweep

`SeriouslyCasualBotV2/src/functions/applications/alts/discoverAlts.ts`.

**Enumeration.** Breadth-first over guilds. The frontier is seeded from four
places, and the fourth is the most valuable idea in the reference implementation:

1. the applicant's own guild;
2. the declared main's guild;
3. the guild of every claimed character;
4. **former guilds mined from Mythic kill history** — `getMythicKillDates`
   returns a `guild` per first kill, so dated guild history rides along free with
   data fetched for another purpose. The comment notes alts are "routinely left
   behind in a guild the main has since left, and no other readable source
   reveals those guilds."

**Caps.** `ALT_CAPS = { guilds: 12, characters: 3000, depth: 3, concurrency: 24 }`.

**Yield and cost.** 12 guilds × ~600 Blizzard roster members ≈ 7,200 candidates,
so the 3,000-fingerprint cap binds rather than acting as a safety net. Cost is 12
roster requests plus up to 3,000 achievement requests — roughly 8% of the
36,000/hour Blizzard budget for a *single* subject, at a measured 333 ms per
achievements call.

**Blind spots.** Unguilded alts; alts in a guild the main has never been in and
never killed a Mythic boss in; bank and auction alts, which are overwhelmingly
guildless; anything beyond depth 3; and levelling characters below the
achievement floor, which produce a null fingerprint the code correctly treats as
*unknown* rather than *no match*.

## Blizzard: the structural facts

Verified from the reference JSON described in Method.

### Rate limits and auth

Verbatim from the Getting Started guide:

> "API clients are limited to **36,000 requests per hour** at a rate of **100
> requests per second**. Exceeding the hourly quota results in slower service
> until traffic decreases. Exceeding the per-second limit results in a **429**
> error for the remainder of the second until the quota refreshes."

Note the asymmetry: the per-second breach is a hard 429, the hourly breach is
*degraded service*. 36,000/hour is exactly 10/s sustained, so the 100/s ceiling
is a burst allowance usable ~10% of the time. Client credentials via
`https://oauth.battle.net/token`; every WoW request must carry a namespace, as
header `Battlenet-Namespace` or query `?namespace=`. Account constraints: 2FA
mandatory, max 50 clients per developer.

### There is no character index, no character search, and no guild index

This is the single fact that makes the ticket hard, and it is now confirmed
rather than assumed.

The **complete** list of retail Game Data search endpoints is fourteen:
`azerite-essence`, `connected-realm`, `creature`, `decor`, `fixture`,
`fixture-hook`, `room`, `item`, `item-appearance`, `journal-encounter`, `media`,
`mount`, `realm`, `spell`. Every one is static game content or realm metadata.
**No searchable character document and no searchable guild document exists.**

Search mechanics: result sets cap at **1,000 entries**; `_page` (default 1),
`_pageSize` (default 100, max 1,000), `orderby=field:asc|desc`, with AND/OR/NOT
and range operators.

> Doc bug worth knowing: the Search Guide still says "currently only the realm
> and connected-realm document types are supported." That sentence is stale — the
> reference documents fourteen. Do not rely on it either way.

Guild endpoints are exactly four, all requiring `realmSlug` + `nameSlug`:
`/data/wow/guild/{realmSlug}/{nameSlug}` plus `/roster`, `/achievements`,
`/activity`. Note the trap: **the path prefix is `/data/wow/` but the namespace is
`profile-{region}`**, not `dynamic-`. There is no guild index and no guild search;
all 38 retail Game Data resource groups were enumerated and nothing of the kind
exists. `guild-crest` endpoints are crest artwork components and enumerate no
guilds.

**Consequence:** guild rosters are a *fan-out* mechanism, never a *seed*. You
must already know a guild name, which normally means already knowing a character
in it. This is exactly why the bot works so hard to mine guild names from kill
history — and, as section E shows, it is also the gap Raider.IO fills.

### A compliance obligation that any corpus must implement

From the Character Profile Status doc:
`/profile/wow/character/{realmSlug}/{characterName}/status` returns validity and a
unique character ID. **Stored character data must be deleted** if the endpoint
404s, if `is_valid` is false, or if the returned character ID differs from the
recorded one. The documented cadence is re-check every **30 days**, retaining a
further 30 on success.

SlashWho's corpus is permanent by design. That is in direct tension with this
rule, and the tension is not hypothetical — a permanent `characters` table with
no revalidation loop is non-compliant. This needs an owner before the corpus
grows further, independent of anything in this ticket.

## Source catalogue

Each entry gives enumeration, yield, cost, freshness and blind spots.

### A. Blizzard realm and connected-realm index

- **Endpoints:** `/data/wow/realm/index`, `/data/wow/connected-realm/index`,
  `/data/wow/connected-realm/{id}`, namespace `dynamic-{region}`. Hosts
  `{us|eu|kr|tw}.api.blizzard.com`; China is `gateway.battlenet.com.cn`.
- **Enumeration:** one index call per region; a connected-realm document embeds
  its constituent `realms[]`, so index + N detail calls gives the complete
  realm→connected-realm mapping. **This is the only genuinely complete
  enumeration in the entire surface.**
- **Yield:** zero characters. It is the outer loop for D and F, not reach.
- **Cost:** ~2 requests per region, cacheable for weeks.
- **Counts:** not documented. *Estimate:* ~80 US, ~120 EU, ~10 KR, ~10 TW →
  **~220–260 connected realms**. Measure by calling the index.
- **Classic** has three separate namespace families, which is more than it used
  to have: `*-classic1x-{region}` (Era), `*-classic-{region}` (MoP Classic
  progression), `*-classicann-{region}` (Anniversary/BC).

### B. Blizzard guild roster — densest per request, but unseedable alone

- **Endpoint:** `/data/wow/guild/{realmSlug}/{nameSlug}/roster`,
  `namespace=profile-{region}`, client credentials.
- **Yield:** ~600 characters per request. The bot measured Blizzard returning
  roughly **twice** Raider.IO's member list for the same guild — 624 vs 312, 688
  vs 420 — because Raider.IO only knows characters it has crawled.
- **Cost:** 1 request per guild. Best characters-per-request of any source here.
- **Freshness:** the namespaces guide states character resources update on
  logout, guild resources "at a regular interval". The bot caches rosters 24 h.
- **Blind spots:** unguilded characters, entirely and permanently. And it cannot
  be used at all without a guild name from elsewhere — see E.

### C. Blizzard PvP leaderboards — trivially cheap, structurally narrow

- **Endpoints:** `/data/wow/pvp-season/index`,
  `/data/wow/pvp-season/{id}/pvp-leaderboard/index`,
  `/data/wow/pvp-season/{id}/pvp-leaderboard/{bracket}`,
  `namespace=dynamic-{region}`, client credentials.
- **Enumeration:** one request per bracket per season per region. **The bracket
  list is not documented** — only the `3v3` default is named. Call
  `pvp-leaderboard/index` rather than hardcoding. *Estimate:* `2v2`, `3v3`,
  `rbg`, plus per-spec `shuffle-*` (~39) and `blitz-*` (~39) → 80+ brackets.
- **Yield:** *estimate* order **10⁴–10⁵ distinct characters per region per
  season** across all brackets; low thousands per bracket for 2v2/3v3/rbg, much
  smaller for per-spec Solo Shuffle.
- **Cost:** order **10² requests per region per season**. Cheapest per character
  in the catalogue by a wide margin.
- **Response contents inferred, not doc-verified:** entries carry
  `character.name`, `character.id`, `character.realm.slug`, rating and win/loss.
  Validate against one real response before designing on it.
- **Blind spots:** rated PvP participants only — a small and unusual slice. And
  rated PvP alts are already among the most publicly linked characters, so the
  marginal information is low even where the yield is high.

### D. Blizzard Mythic Keystone leaderboards — the volume faucet

- **Endpoints:**
  `/data/wow/connected-realm/{id}/mythic-leaderboard/index` and
  `/data/wow/connected-realm/{id}/mythic-leaderboard/{dungeonId}/period/{period}`,
  `namespace=dynamic-{region}`. Supporting indexes:
  `/data/wow/mythic-keystone/{dungeon,period,season}/index`.
- **Enumeration:** nested loop over connected realms × dungeons × periods.
  Prefer the **per-realm `mythic-leaderboard/index`** over the global dungeon
  index — it returns the dungeons actually available on that realm this period,
  so it avoids wasting requests on 404s.
- **Response contents inferred, not doc-verified:** `leading_groups[]` each with
  `members[]` carrying `profile.name`, `profile.id` and `profile.realm.slug`. Five
  named characters with realms per run — exactly the tuple a matcher needs.
- **Cost:** ~250 connected realms × ~10 dungeons ≈ **2,500 requests per period**,
  plus ~250 index calls ≈ **2,750** — about **7.6% of one hour's quota**, roughly
  30 seconds at the 100/s ceiling. A whole season (~20 periods) is ~55,000
  requests, so budget about two hours.
- **Yield:** *estimate* order **10⁵–10⁶ distinct characters** per region per
  season.
- **Blind spots — severe and quantified:**
  - **The 500-run cap is a popularity filter, not a sample.** Raider.IO's support
    documentation states "Blizzard's API will show a maximum of 500 runs for a
    given Realm and Dungeon", and that on high-population realms lower runs get
    "pushed off" the leaderboard and so are not "picked up by RaiderIO". The
    source is therefore biased *against* exactly the casual, low-key players
    whose alts are hardest to find another way — and the bias is worst on the
    biggest realms. Raider.IO's `/api/v1/mythic-plus/leaderboard-capacity`
    exposes the qualifying threshold per realm, which makes the bias measurable.
  - Non-M+ players are invisible: raid-only, PvP-only, levelling, every bank alt.
  - Cross-realm groups appear under several realms, inflating raw counts.

### E. Blizzard Hall of Fame and Raider.IO raid rankings — the missing guild index

This is the most important finding in the ticket, because it dissolves the
constraint in section B.

Blizzard has no guild index. **Raider.IO effectively is one.**

- `GET /api/v1/raiding/raid-rankings` — params `raid`, `difficulty`, `region`
  (primary or subregion), optional `realm`, `guilds` (up to 10 ids), `limit`
  (default 50, **max 200**), `page` (min 0, **no documented maximum**). Returns
  guild objects with name, realm and region. **200 guilds per request with
  unlimited paging** is a guild enumerator in all but name.
- `GET /api/v1/raiding/hall-of-fame?raid=&difficulty=&region=` returns
  `hallOfFame.bossKills[].defeatedBy.{totalCount, guilds[]}`. Measured today:
  8,668 guilds had killed `imperator-averzian` on Mythic. This is the functional
  Cutting Edge cohort.
- `GET /api/v1/raiding/boss-rankings` — verified live to return **guilds only**,
  no character objects. Same for `raid-rankings`. `raiding/progression` returns
  aggregate counts only.
- Blizzard's own `/data/wow/leaderboard/hall-of-fame/{raid}/{faction}`
  (`dynamic-{region}`) also returns first-clear **guilds**, not characters — a
  small, free source of guild name slugs.

**The combination is what matters.** Raider.IO raid-rankings yields guild names
at 200 per request; Blizzard guild roster converts a guild name into ~600
characters per request. Neither codebase currently does this. It is the highest-
yield legitimate path available and it reaches the guilded mid-population that
the leaderboards structurally exclude.

- **Cost:** *estimate* ~30,000 requests to enumerate ~30,000 guilds via
  raid-rankings, then one roster request each. Roughly 60,000 requests total for
  *estimate* 3–9 million character rows.
- **Blind spots:** guildless characters, absolutely. Also biased toward guilds
  that raid at all — a guild that has never killed a ranked boss does not appear
  in raid-rankings.

### F. Raider.IO Mythic+ runs

- **Endpoint:** `GET /api/v1/mythic-plus/runs`, params `season` (default
  `season-mn-1`), `region` (`us|eu|tw|kr|cn|world`), `dungeon` (name/slug/`all`),
  `affixes`, `page`, `access_key`.
- **Measured today, not documented:** page size is **20 runs**, sorted by score
  descending. Page cap is **100 unauthenticated** (`page=101` → 400 "page must be
  less than or equal to 100 when no access_key is provided") and **1,000 with an
  access key**. So a slice yields **2,020 runs unauthenticated / 20,020 with a
  key** per (season, region, dungeon, affix) tuple.
- **Each run carries the full 5-person roster** with nested
  `character.{name, class, spec, level, realm{slug, id, connectedRealmId}, region}`
  — no second lookup needed. Higher-quality payload than Blizzard's leaderboard.
- **Cost and yield for a full unauthenticated sweep:** 5 regions × 8 dungeons
  (`season-mn-1`, from `mythic-plus/static-data`) × ~12 affix combos *(estimate)*
  × 101 pages ≈ **48,500 requests** → ~970,000 runs → ~4.85M character slots →
  *estimate* **200,000–800,000 unique characters**. Dedup is severe (~10–15%
  uniqueness): a five-man group contributes the same five names to every dungeon
  it clears, and deep pages cluster at identical scores.
- **Verdict:** worse than Blizzard's own leaderboards on cost per unique
  character, and it inherits the same 500-run upstream cap. Its advantage is
  payload richness and no Blizzard credentials required.
- Related: `/api/v1/mythic-plus/run-details?season=&id=`,
  `/api/v1/mythic-plus/leaderboard-capacity` (the per-realm cap threshold),
  `/api/v1/periods` (authoritative weekly reset boundaries; current period 1075,
  US window `2026-08-04T15:00Z` → `2026-08-11T15:00Z`).

### G. Raider.IO guild profile members and boss kills

- `GET /api/v1/guilds/profile?region=&realm=&name=&fields=members` — `members` is
  a **documented** `fields` value ("retrieve guild members details"). Measured
  live: 950 member entries for one large guild. Each entry is
  `{rank, character{name, race, class, active_spec_name, active_spec_role, gender,
  faction, achievement_points, region, realm, last_crawled_at, profile_url}}` —
  the flat legacy shape, no IDs and no M+ score.
  - Note: `fields=roster` is silently ignored; the field name is exactly
    `members`.
  - This corrects the ticket's hypothesis: Raider.IO **does** expose a roster.
  - It yields roughly half what Blizzard's roster does for the same guild, so
    Blizzard is preferred *when credentials exist* — but Raider.IO is not
    "dominated", because Raider.IO is also the only way to find the guild in the
    first place (section E).
- `GET /api/v1/guilds/boss-kill?region=&realm=&guild=&raid=&boss=&difficulty=` —
  verified to return `roster[]` of ~20 characters with talent loadouts and item
  levels. A useful second hop from raid-rankings when full rosters are overkill.

### H. Raider.IO rate limits and terms — a real constraint, not a formality

The retail spec **no longer states a number**. Verbatim from
`raider.io/swagger.json` v0.62.5:

> Unauthenticated requests are rate limited. Exceeding the limit results in HTTP
> 429 carrying `Retry-After` (whole seconds), plus `X-RateLimit-Limit`,
> `X-RateLimit-Remaining` and `X-RateLimit-Reset`. Honour `Retry-After` rather
> than retrying on a fixed interval.

The Classic spec (v2.0.39) still carries the older figure: "Unauthenticated
requests are limited to **200 requests per minute**." Treat 200/min as
indicative only. The `X-RateLimit-*` headers were **not** present on ordinary 200
responses in probing, so the budget is only discoverable on a 429.

Acceptable use, verbatim, and this is the clause that bites:

> This API is provided for community and personal use. You may not use it to
> build competing services, resell data, or engage in any activity that harms the
> Raider.IO platform or its users. **Automated scraping beyond the published
> endpoints is prohibited.** Raider.IO reserves the right to revoke API access at
> any time.

Attribution is mandatory: public-facing applications must link back to raider.io.
Commercial or enterprise rate limits go through `hello@raider.io`.

Two things follow that a budget ticket must confront:

1. **The "competing services" clause is a live question for SlashWho**, which is
   a public website built substantially on Raider.IO data. This is a
   relationship question, not just an engineering one, and the right move is
   probably to ask Raider.IO directly and get an access key rather than to
   discover the answer by having access revoked.
2. **The efficient path is the prohibited one** — see I.

### I. Raider.IO's undocumented character rankings — flagged, not recommended

`GET /api/mythic-plus/rankings/characters` (note: **no `/v1/`**) does not appear
in `swagger.json` or `openapi.json`. Measured today with
`?region=world&season=season-mn-1&class=all&role=all&page=N`:

- 100 characters per page, **one row per unique character** — no dedup needed,
  unlike `/runs`.
- Rich nested character shape including realm and region.
- Filters: `region`, `realm`, `class`, `role`, `season`.
- Paging is effectively uncapped: page 46,156 is the last populated page, ending
  at **rank 4,615,612**. So **46,157 requests enumerate 4.6 million unique
  characters, already score-ranked.**

That is roughly the same request budget as the entire unauthenticated `/runs`
sweep for about ten times the unique yield. It is also squarely inside
"automated scraping beyond the published endpoints is prohibited". Recorded here
because the ticket asked what is enumerable and this is the honest answer to
that question — but it should not be built on. `/api/v1/mythic-plus/rankings/characters`
and `/api/v1/characters/rankings` return the SPA HTML shell with HTTP 200; do not
mistake that for a working endpoint.

The bot's existing internal-API usage
(`raider.io/api/characters/{region}/{realm}/{name}`,
`/api/user/view-characters`, `.../raid-progress?tier=`) sits in the same
category. Its own module header calls these "undocumented and may change without
notice" and paces them at 700 ms because "calling these back-to-back drops
payloads silently". They are lookups, not enumerators, and the volume is small —
but the same terms clause covers them.

### J. Blizzard account profile — ground truth, only with consent

- **Endpoint:** `GET /profile/user/wow`, requiring the **Authorization Code Flow
  with the `wow.profile` scope**. Doc wording: "Because this endpoint provides
  data about the current logged-in user's World of Warcraft account, it requires
  an access token with the `wow.profile` scope acquired via the Authorization
  Code Flow." Client credentials cannot reach it. Related:
  `/profile/user/wow/protected-character/{realmId}-{characterId}` and the
  `/collections` family.
- **Yield:** every character on the authenticated account, authoritatively, in
  one request.
- **Blind spot:** it can only ever describe the consenting user — structurally
  useless for finding a third party's alts, which is what SlashWho does.
- **Why it is in the catalogue:** it is the only source in existence that
  produces a *correct and complete* answer. Every other source is inferential and
  shares an accuracy ceiling. An opt-in "claim your account" route is the only
  escape from that ceiling, and it is worth naming as a strategic option even
  though the MVP has no user accounts.

### K. Things that do not leak character names

- **Auction house is anonymised.** `/data/wow/connected-realm/{id}/auctions` and
  `/data/wow/auctions/commodities` describe "all active auctions" with no seller
  or owner field documented and none in the live payload. Responses can exceed
  10 MB and refresh roughly hourly. Verified negative as far as the docs allow.
- **No bulk character achievements or statistics.**
  `/profile/wow/character/{realm}/{name}/achievements` and
  `/achievements/statistics` are strictly per-named-character; nothing aggregates
  them. This is also why the fingerprint costs one request per candidate, which
  is the real budget constraint (see Bottom line).
- **Raider.IO has no `/api/v1/regions` and no `/api/v1/realms`** — both return
  the generic router-miss 400, identical to an obviously fake path. Realm lists
  must come from Blizzard or be harvested from run/ranking payloads, which embed
  full realm objects.

### L. Unknowns worth a live probe

- **Blizzard Neighborhood API** (new, `dynamic-{region}`):
  `/data/wow/neighborhood-map/index`, `/{id}`,
  `/{id}/neighborhood/{neighborhoodId}`. Part of WoW Housing. Neighborhoods are
  player-populated and the endpoint is index-shaped, so it *may* enumerate
  resident characters or owning guilds. No response schema in the docs, so this
  could not be settled either way. Low cost to check, non-trivial upside — it
  would be the first population-level handle Blizzard has shipped in years.
- **Warcraft Logs** was examined and largely rejected. The bot already holds
  credentials (`src/services/warcraftlogs.ts`) and
  `reportData.report.masterData.actors(type:"Player")` returns every player in a
  log. But **actors carry a name with no realm**, and SlashWho's canonical key is
  `(region, realm-slug, normalized-name)`. Cross-realm raiding makes a bare name
  ambiguous, so each name needs a resolving lookup, which erases the saving. Its
  budget model is also different — a points-per-hour allowance the bot reads from
  `rateLimitData { limitPerHour pointsSpentThisHour }` — so query complexity, not
  request count, is the constraint. Rankings carry server information and are the
  salvageable part.

### M. SlashWho's own corpus

The one asymmetry SlashWho has over the bot. It deserves a blunt answer.

**As a candidate generator it is an appealing dead end.** Three reasons, in
increasing order of severity:

1. **Cold start.** The MVP design targets "tens to low hundreds of searches per
   day". At ~100 searches/day and an optimistic ~10 net-new characters each, the
   corpus grows order 10³/day before deduplication — and deduplication will be
   heavy, because searches concentrate on the same popular characters. A
   realistic year-one corpus is **10⁴–10⁵ characters** against an active retail
   population of order **10⁷**; Raider.IO's own ranked list has 4.6 million
   characters in one season. Coverage of roughly 0.1–1%. The chance a given
   target's unknown alt is already in the corpus is negligible.
2. **The selection bias runs the wrong way.** The corpus contains (a) characters
   somebody typed a URL for, and (b) their *already-discovered* alts. Group (b)
   is the problem: those characters are present precisely *because* their account
   link was already resolvable from Raider.IO. Re-offering them as candidates
   proposes the characters we least need to discover. The corpus is
   systematically enriched in solved cases and impoverished in unsolved ones —
   the exact opposite of what a candidate pool should be.
3. **The schema does not support it.** No read path, no guild column, no owner
   column, no recency index. Only `(region)` and `(region, realm_slug)` prefix
   scans are cheap.

**But two narrower versions are real, and one is valuable.**

*The weak-but-free one: the snapshot closure.* `snapshot_characters` already
records established groupings. Taking the transitive closure over snapshots — if
A and B shared a snapshot and B and C shared a later one, then A, B and C are one
account — costs zero external requests and is a strictly correct extension of
existing answers, not a guess. It grows monotonically with usage. It is not a
candidate source; it is a free improvement to the *answer*, and conflating the
two would overstate reach.

*The strong one: the corpus as a pre-paid candidate pool.* Candidate enumeration
is expensive because each candidate costs a fetch — and section K established
there is no bulk achievements endpoint, so that is one request per candidate,
permanently. A character already in the corpus **with a stored signature** costs
zero requests to test. That inverts the economics: reach stops being bounded by
one job's request budget and starts accumulating across all jobs. This is the one
thing the bot fundamentally cannot do, because it fingerprints per-job against a
48-hour TTL and discards the work.

What it would honestly take:

- **A signature store, which does not exist — and the naive version does not
  fit.** The bot measured 1,775 cached fingerprints taking its database from
  ~15 MB to 108 MB: about **82 KB each** as raw JSON, ~33 KB gzipped and
  base64-encoded. At 10⁵ characters that is roughly **3.3 GB**. A full
  achievement-timestamp map is not storable at corpus scale. This needs a
  **compact derived signature** — a fixed-size hash or sketch over
  rare-achievement timestamps — whose false-positive rate is characterised
  *before* anything is built. That is a separate research question and a real one.
- Blizzard client credentials and a fingerprint pass — the dependency named
  earlier.
- An enumeration read path and an index matching whatever the sweep scans by.
- **A retention answer that reconciles the permanent corpus with Blizzard's
  30-day revalidation rule**, and a privacy answer. `suppressed_characters` must
  filter candidate generation, not only output. Turning a permanent corpus from a
  record of answers into an active index of players who never searched for
  themselves is a materially different product from the MVP's, and should be
  decided deliberately.

**Verdict: not a source of reach.** It can never enumerate characters nobody has
searched for. It is potentially a source of *cheapness*, which is different and
still worthwhile, but only after a compact-signature design and only once a
matcher exists. Any plan counting the corpus toward year-one reach is counting
something that is not there.

## The blind spot none of these sources closes

Every enumerable source above is drawn from **organised endgame activity**: guild
membership, Mythic+ leaderboards, rated PvP, raid logs, raid rankings. The union
of all of them still cannot see:

- unguilded characters that do not run Mythic+, rated PvP, or logged raids;
- bank alts, auction alts and profession alts — usually guildless, absent from
  every ranked system, and often *the very characters someone is keeping
  separate*;
- levelling and freshly-created characters, which additionally have too few
  achievements to fingerprint at all;
- anyone on a realm or region the sweep does not enter;
- characters whose owner has hidden their Raider.IO profile *and* who appear in
  none of the above.

No budget fixes this. It is a property of what Blizzard makes enumerable, not of
how hard we sweep. The only route past it is consent (J).

## Bottom line

**Worth pursuing, in order.**

1. **Raider.IO `raid-rankings` → Blizzard guild roster.** The most valuable
   finding here. Blizzard has no guild index, but Raider.IO's raid-rankings
   returns 200 guilds per request with no page cap, and a Blizzard roster
   converts each guild name into ~600 characters for one more request. Neither
   codebase does this today. It is the only legitimate path that reaches the
   guilded mid-population the leaderboards structurally exclude.
2. **Blizzard Mythic Keystone leaderboards.** ~2,750 requests enumerates a
   period across US+EU — 7.6% of one hour's quota — for order 10⁵–10⁶ distinct
   characters. Best cost-per-character of any bulk source. Its 500-run cap is a
   real bias against exactly the casual players we most want, but it is a *known,
   measurable* bias (`leaderboard-capacity` quantifies it per realm).
3. **Blizzard PvP leaderboards.** Order 10² requests for essentially the whole
   rated population. So cheap it barely needs a budget decision; just narrow, and
   skewed toward already-linked characters.
4. **Targeted seeding, kept from the bot.** Rosters chosen *because of a link to
   the root* beat any bulk source on relevance. The kill-history mining of former
   guilds is the best idea in the reference implementation and should be copied
   outright.
5. **Consent-based account profile.** The only source that is correct rather than
   inferred. A product decision, but it belongs on the table before more
   engineering is spent chasing the accuracy ceiling from below.

**Dead ends.**

- **Character index or character search.** Does not exist — confirmed against
  the full fourteen-endpoint search list. Any design assuming the key space can
  be probed is unimplementable.
- **A Blizzard guild index.** Does not exist either; route around it via
  Raider.IO (E).
- **Raider.IO `mythic-plus/runs` as a bulk enumerator.** 2,020 runs per slice
  unauthenticated, ~10–15% uniqueness, and it inherits Blizzard's 500-run cap
  anyway. Dominated by going to Blizzard's leaderboards directly.
- **Warcraft Logs report rosters.** Realm-less names cannot be resolved to a
  canonical key without a per-name lookup that erases the saving.
- **Raider.IO's undocumented character rankings.** Technically the best
  enumerator in existence (4.6M characters for 46k requests) and explicitly
  prohibited by the terms. Not an option.
- **The self-corpus as a candidate generator.** Cold start plus inverted
  selection bias.

**Realistic ceiling on reach.**

Enumeration is *not* the binding constraint the ticket's framing implies. The
leaderboards can put 10⁵–10⁶ characters in front of a matcher for a few thousand
requests, and the guild path can put millions. What binds is **the cost of
testing them**: there is no bulk achievements endpoint, so it is one request per
candidate, and at 36,000 requests/hour a 36,000-candidate sweep consumes an
entire hour of the global budget for one subject.

**Reach is bounded by the matcher's per-candidate cost, not by the enumerator's
yield.** The highest-leverage follow-up is therefore not a bigger enumerator but
a cheaper test — or a pre-paid one (M).

Given that, the honest ceiling per subject is roughly the current one: low
thousands of *tested* candidates. The achievable gain comes from **choosing
better candidates, not more of them** — a well-seeded 3,000-candidate sweep
including former guilds and leaderboard co-participants will beat a
30,000-candidate sweep drawn from the same twelve guilds. And whatever the
budget, the structural blind spot stands: bank alts, levelling alts and unguilded
non-participants are not findable from any public source, and the product should
say so plainly.

## Open questions for the follow-up ticket

- Validate the two Blizzard leaderboard response shapes against one real
  response each; neither is doc-verified.
- Probe the Neighborhood API — it is the only candidate for a new
  population-level handle.
- Measure, do not assume: connected-realm counts, the live PvP bracket list,
  Raider.IO's current retail rate limit.
- Approach Raider.IO for an access key and clarity on the "competing services"
  clause before building anything at volume on their API.
- Assign an owner to Blizzard's 30-day character revalidation obligation; the
  permanent corpus is currently in tension with it.
- Establish whether a compact fingerprint signature can be stored at corpus
  scale with an acceptable false-positive rate.
- Decide the ordering: matcher first or enumerator first. Candidates without a
  matcher are worth nothing.

## Sources

**Codebase**, read 2026-08-06 at commit `8cd0ea1`:

- `SeriouslyCasualBotV2/src/functions/applications/alts/discoverAlts.ts`
- `SeriouslyCasualBotV2/src/services/{blizzard,raiderio,raiderioInternal,warcraftlogs}.ts`
- `packages/database/src/{schema,repositories}.ts`
- `packages/domain/src/discovery.ts`
- `docs/superpowers/specs/2026-08-04-slashwho-mvp-design.md`

**Blizzard**, all retrieved 2026-08-06. Reference content served as JSON from
`https://community.developer.battle.net/api/pages/content/documentation/{path}.json`;
human-readable equivalents at
`https://community.developer.battle.net/documentation/{path}`:

- `world-of-warcraft/game-data-apis` — the 38 retail resource groups, the
  fourteen search endpoints, leaderboard and index paths.
- `world-of-warcraft/profile-apis` — guild endpoints, character profile
  endpoints, `/profile/user/wow` and the `wow.profile` scope, the character
  status revalidation rule.
- `world-of-warcraft-classic/{game-data-apis,profile-apis}` — Classic endpoints.
- `guides/getting-started` — rate limits (36,000/hour, 100/second), auth flow,
  client constraints.
- `world-of-warcraft/guides/namespaces` and
  `world-of-warcraft-classic/guides/namespaces` — namespace families and update
  cadence.
- `world-of-warcraft/guides/search` — search operators and paging (and the stale
  "realm and connected-realm only" sentence).
- Corroborating: Blizzard Forums,
  [API Access - Clients - Rate Limits](https://us.forums.blizzard.com/en/blizzard/t/api-access-clients-rate-limits/5602)
  and [Lets Talk Throttling](https://us.forums.blizzard.com/en/blizzard/t/lets-talk-throttling/32429).

**Raider.IO**, all retrieved 2026-08-06:

- <https://raider.io/swagger.json> — Swagger 2.0, `info.version` 0.62.5, 37
  paths; rate-limit and acceptable-use text in `info.description`.
- <https://raider.io/openapi.json> — OpenAPI 3.0 rendition, identical path set.
- <https://classic.raider.io/swagger.json> — v2.0.39; retains the "200 requests
  per minute" figure.
- <https://support.raider.io/kb/frequently-asked-questions/how-does-the-mythic-plus-leaderboard-slash-api-capacity-work>
  — the 500-run-per-realm-per-dungeon cap.
- Live probes against `https://raider.io/api/...` for all page-size, page-cap and
  response-shape claims.
