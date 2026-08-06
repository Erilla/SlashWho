# Fingerprint mechanics and per-character cost on the current API

Research note for [issue #6](https://github.com/Erilla/SlashWho/issues/6). Retrieval date for every
source in this note: **6 August 2026**.

## How to read the numbers in this note

Every claim is tagged, and the tags are not decoration — the feasibility of the whole effort rests on
one number that is an estimate, and on one mechanism that Blizzard's reference documentation does not
describe at all.

| Tag | Meaning |
| --- | --- |
| **[documented]** | Stated by Blizzard's official developer documentation, quoted and linked below. |
| **[staff]** | Stated by a verified Blizzard employee on the official developer forums. Authoritative but not a published contract, and dated. |
| **[measured]** | Recorded by SeriouslyCasualBotV2 running against the live API, from its code comments and design docs. Historical — the runs date from July–August 2026 and were not re-run for this note. |
| **[estimated]** | Derived or inferred here. Not measured. Never quote as a measurement. |
| **[community]** | Reported by non-staff users on official forums. Weak evidence; flagged wherever used. |
| **[unknown]** | Not established by any source consulted. Called out rather than guessed. |

No live API calls were made: there are no Blizzard API credentials in this repo or this environment.
Everything **[measured]** is second-hand from the bot's own record of its runs.

---

## 1. The documentation moved

`develop.battle.net` now returns **301 Moved Permanently** to `community.developer.battle.net`.
The path structure is unchanged. **[documented]** — observed directly on
`https://develop.battle.net/documentation/world-of-warcraft/profile-apis`.

The new portal is an Angular single-page app, so fetching a documentation URL returns only a
JavaScript shell. The rendered content is served as JSON from the portal's own content API, which is
what this note cites:

```
https://community.developer.battle.net/api/pages/content/{path}.json     # page body + API reference
https://community.developer.battle.net/api/pages/pages/{path}.json       # page metadata
https://community.developer.battle.net/api/pages/navigation/{path}.json  # site map
```

An `api-reference` page returns
`{ resources: [{ name, methods: [{ name, description, path, httpMethod, cnRegion, parameters }] }] }`.
This is worth recording because it makes the whole reference machine-readable and diffable — a future
ticket could watch it for changes rather than re-reading it by hand.

The **API hosts themselves are unchanged**: `https://{region}.api.blizzard.com` for `us | eu | kr | tw`,
`https://gateway.battlenet.com.cn` for China, and `https://oauth.battle.net/token` for tokens.
**[documented]**

Nothing in SeriouslyCasualBotV2 hardcodes the docs host, so this breaks no code. It does mean any
bookmark or comment pointing at `develop.battle.net` should be updated.

---

## 2. The endpoint

**[documented]** The Character Achievements Summary endpoint is exactly what the bot uses:

```
GET https://{region}.api.blizzard.com/profile/wow/character/{realmSlug}/{characterName}/achievements
    ?namespace=profile-{region}
    &locale={locale}
```

From the API reference for `documentation/world-of-warcraft/profile-apis`:

> **Character Achievements Summary** — "Returns a summary of the achievements a character has completed."
> `GET /profile/wow/character/{realmSlug}/{characterName}/achievements`

| Parameter | Required | Documented as |
| --- | --- | --- |
| `{realmSlug}` | yes | "The slug of the realm." Example `tichondrius`. |
| `{characterName}` | yes | "The lowercase name of the character." |
| `namespace` | yes | "The namespace to use to locate this document." Example `profile-us`. |
| `locale` | no | Defaults to `en_US`. |

A sibling endpoint `GET .../achievements/statistics` exists ("Returns a character's statistics as they
pertain to achievements") and is **not** what the fingerprint uses.

The namespace **must** be present on every WoW API request, either as `?namespace={namespace}` or as a
`Battlenet-Namespace:` header. **[documented]** —
[Namespaces](https://community.developer.battle.net/documentation/world-of-warcraft/guides/namespaces).

`src/services/blizzard.ts` in SeriouslyCasualBotV2 builds precisely this URL with the query-parameter
form and `locale=en_GB`. **The endpoint, path, and namespace the bot depends on are all still current.**

### Authentication: client credentials, not user OAuth

This is the fact that makes the whole approach possible, and it holds. The naming is misleading —
"Profile API" here means *profile namespace*, not *user-consented*.

**[documented]** The
[Authorization Code Flow guide](https://community.developer.battle.net/documentation/guides/using-oauth/authorization-code-flow)
gives an exhaustive list:

> Currently, the authorization code flow provides access tokens for the following requests:
> `GET /userinfo`, `GET /profile/user/wow`,
> `GET /profile/user/wow/protected-character/{realm-id}-{character-id}`,
> `GET /profile/user/wow/collections`, `GET /profile/user/wow/collections/pets`,
> `GET /profile/user/wow/collections/mounts`

`/profile/wow/character/.../achievements` is not on that list. The
[Client Credentials Flow guide](https://community.developer.battle.net/documentation/guides/using-oauth/client-credentials-flow)
states the complement:

> The client credentials flow is used for most API requests, with the exception of those listed on the
> OAuth authorization code flow page.

Corroborating from the reference itself: within the Profile APIs, the *only* methods whose descriptions
mention the `wow.profile` scope are the nine under **Account Profile API** (`/profile/user/wow*`).
Every character-scoped method, achievements included, carries no such note. **The OAuth line is drawn at
`/profile/user/wow*`.**

So: **a character's achievement history is readable with an application access token, with no consent
from the character's owner.** The token comes from `POST https://oauth.battle.net/token` with
`grant_type=client_credentials` and HTTP basic auth; the documented example response carries
`"expires_in": 86399` — roughly 24 hours. **[documented]**

Confirmed operationally: SeriouslyCasualBotV2 runs the sweep in production against thousands of
arbitrary characters using only `BLIZZARD_CLIENT_ID` / `BLIZZARD_CLIENT_SECRET`. **[measured]**

Two access prerequisites worth noting for SlashWho's deployment story, both **[documented]** in
[Getting Started](https://community.developer.battle.net/documentation/guides/getting-started):
two-factor authentication is **required** on the Battle.net account for any API usage, and a developer
is limited to **50 clients**.

### Freshness

**[documented]** — [Namespaces guide](https://community.developer.battle.net/documentation/world-of-warcraft/guides/namespaces):

> Resources related to characters are updated upon character logout. Resources related to guilds are
> updated at a regular interval.

An already-earned achievement's timestamp is immutable, so staleness can only ever mean *missing the
newest entries*, never wrong ones. A dormant alt still returns its full history, so inactive
characters are just as fingerprintable as active ones — which is exactly the population the feature
most needs to reach.

But note the sharper consequence, which §8 returns to: **a character's document is a snapshot frozen at
its last logout.** An alt parked for six months will not reflect account-wide achievements the account
earned since. This is a plausible partial explanation for why real same-account matches score 31–86%
rather than ~100%.

---

## 3. What the response contains

### The reference documents no response schema — for any endpoint

Blizzard's WoW API reference documents, for every endpoint: name, description, HTTP method, path,
whether it exists in the CN region, and the request parameters. Verified programmatically across the
complete Game Data and Profile API references — the union of all keys on every documented method is
exactly:

```
['cnRegion', 'description', 'httpMethod', 'name', 'parameters', 'path']
```

Occurrence counts across the whole profile-apis reference: `completed_timestamp` → **0**,
`total_quantity` → **0**, `total_points` → **0**, `schema` → **0**.

**There is no documented response schema, field list, or example response for any WoW endpoint.** The
WoW guides index confirms no supplementary guide covers it either — the only WoW guides published are
Namespaces, Known Issues, Localization, Media Documents, Character Renders, and Search.

So the field-level contract is undocumented and could change without any docs diff. Pin it with
integration tests rather than trusting the reference.

### But the mechanism *is* confirmed — by a Blizzard developer, in detail

This is the single most important source for the whole effort, and it is stronger than expected.

**[staff]** Thread: *"Character Achievements API: When is an achievement 'completed'?"*,
<https://us.forums.blizzard.com/en/blizzard/t/character-achievements-api-when-is-an-achievement-completed/7171>,
post #1 by **Araspir**, **18 May 2020**. Staff status verified from the raw Discourse JSON rather than
the rendering: `staff: true`, `moderator: true`, `primary_group_name: "developer"`,
`user_title: "Blizzard Developer"`.

WoW has two achievement types, distinguished by `is_account_wide` on `/data/wow/achievement/{id}`.
Assuming the "Display Only Character Achievements To Others" option is **disabled** (the default —
see below), the post says, verbatim:

For **account** achievements:

> The achievement criteria completion, `criteria.is_completed`, is true when the conditions for the
> criteria have been met for any character across the account. […] The completion timestamp,
> `completed_timestamp`, appears when the achievement has been completed by the account.

> Because of this, account achievements look the same for all characters across the account, provided
> the "Display Only Character Achievements To Others" flag is disabled.

For **character** achievements:

> The achievement criteria completion, `criteria.is_completed`, is only tracked for the character that
> you requested […] The completion timestamp, `completed_timestamp`, appears when the achievement has
> been completed by **any character on the account**.

> […] a character achievement with `criteria.is_completed` as false but with a `completed_timestamp`
> appearing means that the achievement was completed by another character on the account.

**Read that carefully, because it is better news than the bot's own comment claims.**
`compareFingerprints.ts` says "account-wide achievements share an identical completion timestamp
across every character on the account", implying the signal comes only from the account-wide subset.
Per Blizzard, `completed_timestamp` is account-scoped for **both** achievement types. `is_completed`
is the field that distinguishes them; the timestamp is account-wide either way. **The entire timestamp
set is the signal, not a subset of it.** That is the strongest possible confirmation of the mechanism
the whole effort rests on.

It also means there is no benefit in filtering the fingerprint to `is_account_wide` achievements via
the static Game Data endpoint — a natural-looking optimisation that would in fact discard signal.

### The one caveat that could break it — and why it has largely expired

**[staff]** Same post. If "Display Only Character Achievements To Others" (DOCATO) is **enabled**:

> The completion timestamp, `completed_timestamp`, appears when the achievement has been completed by
> the requested character.

> Effectively, enabling the in-game option removes all links to your other characters for both
> achievement types, only showing that one character's progress. **For data protection reasons, we do
> not explicitly expose whether or not a character has the in-game option enabled or disabled.**

So a character with DOCATO enabled returns character-scoped timestamps, and **the API gives you no way
to detect this.**

Crucially, note the *direction* of the failure. Such a character's timestamps would not match its own
alts, so it produces a **false negative** — a missed alt — never a false positive. It degrades recall,
never precision. For an alt-discovery tool that is the benign direction, and it means the 20% threshold
is not endangered by it.

**[community]** And the caveat has largely expired. Thread
<https://us.forums.blizzard.com/en/wow/t/display-only-character-achiev-to-others-is-gone/2066215>,
opened **26 February 2025**:

> it looks like the option to 'display only character achievements to others' has been removed from the
> options menu (both retail and Classic Cata).

A follow-up on **5 March 2025** reports that the setting is not merely unsettable but actively cleared:

> as soon as you log on to that character, that option is forcibly removed. […] I logged in to that
> character, got the Undermine splash screen, then logged out. Sure enough, they suddenly got thousands
> of achievement points.

Another poster cites Warcraft Wiki listing the removal as an undocumented change in **patch 11.1.0**.
**No Blizzard staff reply appears anywhere in that 13-post thread**, so this is community reporting,
not confirmation. But if it is accurate the residual exposure is small and shrinking: any character
that has logged in since March 2025 has had the flag cleared, and characters that have not logged in
since March 2025 are largely outside the population a recruitment- or alt-discovery tool cares about.

**[community]** The modern replacement is account-level, not per-character: a Battle.net web setting
under **Privacy & Communication → Game Data And Profile Privacy → "Share Game Data"**. Turning it off
hides the account's game data wholesale. What the achievements endpoint returns for such an account is
**[unknown]** — a 403, a 404, or an empty document are all plausible, and this is worth establishing
in the prototype because it is now the *only* live privacy mechanism.

### The shape actually observed

**[measured]** From `src/services/blizzard.ts` and `tests/unit/blizzardFingerprint.test.ts`, the only
parts of the response the bot reads:

```jsonc
{
  "achievements": [
    { "id": 1, "completed_timestamp": 1700000000000 },
    { "id": 3 }                                        // present, no timestamp — excluded
  ]
}
```

Two consequences, both load-bearing:

1. `completed_timestamp` is **absent** on achievements the character has not completed — the bot's
   filter is `if (a.completed_timestamp)`, and its fixture deliberately includes `{ id: 3 }` with no
   timestamp as an excluded case. **The array is therefore longer than the completed count**: the
   endpoint returns entries for incomplete achievements too.
2. The timestamp is Unix epoch **milliseconds**.

**[staff]** The forum post confirms further fields the bot discards: `criteria.id`,
`criteria.is_completed`, `criteria.child_criteria[].is_completed`, and per-achievement
`achievement: { key: { href }, name, id }` (visible in a real response quoted in post #2 of that
thread). `total_quantity` and `total_points` could not be confirmed from any Blizzard source and remain
**[unknown]**.

### Response weight

No source consulted documents or measures the wire size of an achievements response.

What *is* **[measured]**, from the disk-pressure analysis in the `FINGERPRINT_TTL_MS` comment and
`tests/unit/blizzardFingerprint.test.ts`:

| Quantity | Value |
| --- | --- |
| Cached fingerprints written on the test bot | 1,775 |
| Database growth | ~15 MB → 108 MB |
| Per fingerprint, as raw JSON of `[id, timestamp]` pairs | **~82 KB** |
| After gzip | ~3.3× smaller |
| After gzip + base64, as actually stored | ~2.4× smaller, so **~34 KB** |

Note carefully what 82 KB is: the **derived** `[[id, ts], …]` array, *after* the bot has discarded
everything else. It is not the response.

**[estimated]** A `[123456,1700000000000],` pair is about 21 bytes, so 82 KB implies roughly
**3,900 completed achievements** on a typical mature character — consistent with the common-achievement
counts observed in real comparisons (1,599–6,395, clustering around 3,000–4,600).

**[estimated]** The wire response should therefore be **1–4 MB uncompressed**, perhaps
**150–400 KB gzipped**: several thousand completed entries plus an unknown number of incomplete ones,
each an object carrying at minimum an absolute `href` (~85 characters alone), a localized name, and a
criteria object, at a conservative 250–600 bytes per entry. **This range is inference, not observation.**

**[community]** The only external corroboration is qualitative, from
<https://us.forums.blizzard.com/en/blizzard/t/wow-profile-achievements-endpoint-slow/14365>
(6 January 2021, non-staff), and it supports the "large" end:

> Sometimes the API transfer rate is slow (under 50KBps), and the achievement endpoint response is large.

In that thread the achievements call took "a couple seconds, or (at worst) up to 10-15 seconds" against
~0.25 s for five other character endpoints, and dropped to "under 3 seconds every time, and usually
only 1-2" once the client sent `Accept-Encoding: gzip, deflate`.

**Two actionable points.** First, the achievements endpoint is by far the heaviest character endpoint,
so per-call latency measured on any other endpoint does not transfer to it. Second — **send
`Accept-Encoding: gzip`**. It is unclear whether SeriouslyCasualBotV2's `httpRequest` does; Node's
`fetch` sets it by default, so the bot's 333 ms figure is probably already a gzipped measurement, but
this should be verified rather than assumed, because if it is *not*, the real per-call cost is better
than measured.

---

## 4. What one fingerprint costs

### Requests

**[measured]** **Exactly one HTTP GET per uncached character.** No pagination, no index call, no
per-achievement lookup — the summary endpoint returns the whole set in one response.
`fetchFingerprintEntries` makes one `httpRequest` call and nothing else.

The OAuth token amortises to effectively zero: one `POST /token` per ~24 hours (`expires_in: 86399`
**[documented]**), cached at module scope with a 60-second safety margin and an in-flight guard so
concurrent callers share one fetch.

**[documented]** Against the published quota of 36,000 requests/hour, one fingerprint is
**1/36,000 of the hourly budget — 0.0028%**.

### Wall time

**[measured]** Two figures from the same sweep (Driptinus-Argent Dawn, guild `Rancour-Draenor`,
313 characters, concurrency 8):

| Source | Elapsed | Throughput | Implied mean latency |
| --- | --- | --- | --- |
| `discoverAlts.ts` / plan doc | 313 in **13 s** | ~24 req/s | **~333 ms** |
| Design doc | 313 in **15.7 s** | ~20 req/s | ~400 ms |

`ALT_CAPS` states the first directly: "the achievements endpoint measured 333ms per call".

**A precision point that matters.** 333 ms is a *throughput-derived mean under concurrency 8*
(8 ÷ 24.1 req/s), not a measured isolated single-request latency. It includes queuing, connection
reuse effects, and client-side JSON parsing. The latency of one fingerprint fetched alone is
**[unknown]**, and the community report above — 1–3 seconds gzipped, single-threaded, in 2021 — is a
reminder that it may not be lower.

**So: one fingerprint costs one request and, as a planning figure, ~333–400 ms of amortised wall time
under concurrency.** Use 400 ms as the safe number and 333 ms as the optimistic one.

### Throughput at scale

**[measured]** 24 req/s at concurrency 8.

**[estimated]** `ALT_CAPS` raises concurrency to 24 and reasons that this "puts it at ~72 req/s — still
inside the ceiling — for ~42s" on a 3,000-character sweep. That is a linear projection from the
concurrency-8 measurement, assuming per-call latency stays flat as concurrency triples. It was not
tested; the comment says so — "Do not push past ~30 without re-measuring". Whether 24 concurrent
actually yields 72 req/s is **[unknown]**.

### Storage

**[measured]** ~82 KB per fingerprint as raw JSON pairs, ~34 KB compressed and base64'd as stored. On
the bot this forced the cache TTL down from a week to 48 hours: 3,000 fingerprints for one applicant is
~235 MB raw against a 434 MB volume, so two applicants inside the TTL window would fill it — and a full
SQLite volume fails *every* write in the process, not just the feature's.

SlashWho is on PostgreSQL rather than a small mounted volume, so the absolute limit differs, but the
per-character figure does not. Treat it as a design input.

### Summary

| Dimension | Cost | Confidence |
| --- | --- | --- |
| HTTP requests | 1 | **[measured]** |
| Share of hourly quota | 1/36,000 = 0.0028% | **[documented]** |
| Wall time, amortised at concurrency 8 | ~333–400 ms | **[measured]** |
| Wall time, single isolated request | — | **[unknown]** |
| Response bytes on the wire | 1–4 MB raw / 150–400 KB gzipped | **[estimated]** |
| Derived fingerprint, raw JSON | ~82 KB | **[measured]** |
| Derived fingerprint, stored compressed | ~34 KB | **[measured]** |

### What would confirm it

The prototype ticket should measure, against a fixed set of ~50 real characters across several realms:

1. **Isolated single-request latency** — sequential, concurrency 1; report median and p95, not mean.
   This number is currently missing entirely and is the honest per-fingerprint cost.
2. **Latency at concurrency 1, 8, 16, 24, 32** — tests whether the 72 req/s projection holds.
3. **`Content-Length` and decompressed body size**, and whether the client is sending and the server
   honouring `Accept-Encoding: gzip`. This settles the only **[estimated]** row above and is the
   highest-value single measurement in the list.
4. **Achievement array length vs. how many entries carry `completed_timestamp`** — confirms the ~3,900
   derivation and shows how much payload is discarded.
5. **Whether `Retry-After` is present on a 429**, and how the per-second and per-hour limits manifest
   differently.
6. **A same-account pair's match percentage**, to test the 31–86% anomaly in §8.

---

## 5. Rate limits

**[documented]** —
[Getting Started § Throttling](https://community.developer.battle.net/documentation/guides/getting-started),
verbatim:

> API clients are limited to **36,000 requests per hour** at a rate of **100 requests per second**.
> Exceeding the hourly quota results in slower service until traffic decreases. Exceeding the
> per-second limit results in a **429 error** for the remainder of the second until the quota refreshes.

**Both figures the bot reasons against are still exactly correct.** Two details its comments do not
capture:

- **The two limits fail differently.** Blowing the per-second limit gives a clean 429 you can back off
  from. Blowing the **hourly** quota gives "slower service until traffic decreases" — degradation, not
  an error. A client watching only for 429s experiences an exhausted hourly budget as mysterious
  latency. Worse, a per-call cost measured during that window would be badly wrong, so the prototype
  must confirm it is not itself throttled when it takes its timings.
- **The quota is per client**, shared across every consumer of a client ID. If SlashWho and
  SeriouslyCasualBotV2 ever share credentials they share the 36,000 — they should not.

---

## 6. Error behaviour

**[unknown] to the documentation.** As established in §3, the WoW API reference publishes no response
or error schemas. There is no documented behaviour for a non-existent, private, renamed, or transferred
character on the achievements endpoint. The string `403` appears zero times in the entire reference.

### What the documentation does say — and it answers the rename/transfer question

**[documented]** — Character Profile Status,
`GET /profile/wow/character/{realmSlug}/{characterName}/status`:

> Returns the status and a unique ID for a character. A client should delete information about a
> character from their application if any of the following conditions occur:
> - an HTTP 404 Not Found error is returned
> - the `is_valid` value is false
> - the returned character ID doesn't match the previously recorded value for the character
>
> […] A client requests and stores information about a character, including its unique character ID and
> the timestamp of the request. After 30 days, the client makes a request to the status endpoint to
> verify if the character information is still valid. If character cannot be found, is not valid, or the
> characters IDs do not match, the client removes the information from their application. If the
> character is valid and the character IDs match, the client retains the data for another 30 days.

**This is the documented answer to renames and transfers, and it is a significant find for SlashWho.**

- A character is identified durably by a **numeric character ID**, not by name-realm. A rename or
  transfer changes the name-realm key while the ID persists; a *different* ID under the same name-realm
  means a different character has taken that name — the case that silently corrupts a name-keyed store.
- Blizzard frames this as a **data-retention obligation**: 404, `is_valid: false`, or a changed ID means
  *delete*, on a documented 30-day re-check cadence.
- SeriouslyCasualBotV2 does not use this endpoint at all — it keys everything on `name-realm` and treats
  a 404 as transient "unavailable". SlashWho, which persists discovery snapshots in PostgreSQL and
  republishes them, has a much stronger reason to adopt it, and arguably an obligation to. It costs one
  request per character, so it belongs on the refresh path, not the sweep path.

**[documented]** — [Known Issues](https://community.developer.battle.net/documentation/world-of-warcraft/guides/known-issues),
the only other error statement, and it concerns child links rather than top-level requests:

> […] a request to the child resource returns a 404, 401, or another appropriate status code and response.

### What the bot observed

**[measured]** The best available evidence for real behaviour:

| Condition | Treatment | Rationale in the code |
| --- | --- | --- |
| 404 | returns `null` — **not cached** | "Genuinely unavailable. `null` already means 'unknown, not a non-match'." |
| 403 | same as 404 | Grouped with 404/500 in the plan's failure-contract table. |
| 5xx | same, after retries | Retryable statuses are `429, 500, 502, 503, 504`. |
| 429, or any attempt that saw a `Retry-After` | **rethrown**, job pauses and resumes | "Turning a rate limit into `null` would report an account as having no alts." |
| Circuit open | rethrown | Same reason. |
| 200 with zero completed achievements | returns `null`, **and this IS cached** | "'This character has earned no achievements' is a real answer." |

The plan document records that a renamed or transferred applicant character "would 404 and fail the
phase instead of skipping the sweep" — so **[measured]**, indirectly, a renamed or transferred character
returns 404 under its old name. A real observation from a live failure, not a controlled test.

**The bot does not distinguish 403 from 404, so its record cannot tell us whether a private profile
behaves differently from a missing one.** That distinction is **[unknown]**.

**[community]** The forum picture is genuinely inconsistent and should not be built on:

- <https://us.forums.blizzard.com/en/blizzard/t/403-character-statistics-api/47246> (September 2023) —
  a reported 403 turned out to be a **malformed namespace** (`profile-de` instead of `profile-eu`). So a
  403 can simply mean a bad namespace, not a permissions problem.
- <https://us.forums.blizzard.com/en/blizzard/t/403-404-classic-classic1x/53959> (to 25 April 2025, no
  staff reply) — 404s reported for recently created characters, suggesting a propagation delay, and 403s
  on protected routes despite holding `wow.profile`.

Rough community consensus, explicitly not a contract: 404 = character not found, not yet propagated, or
never logged in since the API cutover; 403 = commonly a bad namespace or a scope issue. Blizzard has
published nothing.

### The one design consequence worth acting on

`null` means **unknown**, never **no match**. Every consumer must preserve that distinction — the bot's
code is emphatic about it in three separate places. A SlashWho implementation that collapses "could not
read this character" into "this character is not an alt" would silently under-report, and
under-reporting is invisible: there is no error to notice. This is the most repeated warning in the
existing implementation and it should be carried across verbatim.

---

## 7. Regions

The documentation answers this cleanly, and more decisively than the question assumed.

**[documented]** —
[Regionality and APIs](https://community.developer.battle.net/documentation/guides/regionality-and-apis),
verbatim:

> Game information is different from region to region. For example, a user that has both US and EU WoW
> accounts has **different characters, achievements, and other information in each region**.

That separates the two things the question rightly kept apart:

1. **A Battle.net account can span regions.** The documentation's own example is a user with both a US
   and an EU WoW account. "One person, characters in two regions" is real and documented.
2. **An achievement set does not span regions.** Achievements are named *explicitly* as per-region data.
   A person's EU completion timestamps have no relationship to their US ones, because those are separate
   WoW accounts with independent achievement histories.

**Conclusion: fingerprints do not compare meaningfully across regions.** Two characters in different
regions belonging to the same human being share essentially no identical completion timestamps, and a
cross-region comparison would score as noise. The per-region fact is **[documented]**; that it implies
non-comparable timestamps is a short **[estimated]** step, cheaply confirmable given one person with
characters in two regions.

Note this also bounds what the whole product can ever claim: SlashWho can find a person's alts *within a
region*, never their characters across regions. That belongs in the product's own wording, not just its
internals.

Two further documented constraints:

**[documented]** China is a separate **account partition**:

> Battle.net operates two main account partitions: one in China and one for the rest of the world. […]
> API requests cannot retrieve global information from the China partition, and vice versa.

| Partition | Regions |
| --- | --- |
| China | CN |
| Global | US, EU, KR, TW |

**[documented]** And every method in the WoW Profile API reference — all 40, achievements included —
carries `"cnRegion": false`. Verified programmatically: the set of Profile API methods with
`cnRegion: true` is empty. **The WoW Profile API is not available in the China region at all.**

So the practical region set is **`us`, `eu`, `kr`, `tw`**, each an independent fingerprint universe.

**A trap worth flagging.** The OAuth guide states that `{region}` is "one of the following: `us`, `eu`,
or `apac`", describing APAC as replacing `kr` and `tw` — while the regionality and namespace guides both
still list `kr` and `tw` as distinct API regions and namespace suffixes. **The APAC consolidation applies
to OAuth hosts, not to the data/profile API hosts or namespaces.** Do not let the OAuth page mislead an
implementation into dropping the `kr`/`tw` namespaces.

**[estimated]** Design consequence: region belongs in the cache key and the comparison key.
SeriouslyCasualBotV2 already keys its cache `fingerprint:{region}:{realm}:{name}` and enforces
single-region comparison *by construction* — in `discoverAlts.ts` every candidate is built as
`{ region: primary.region, … }`, so a cross-region comparison is unreachable. SlashWho should make that
guarantee explicit rather than incidental, because its inputs are arbitrary Raider.IO URLs which *do*
carry a region and could differ between two characters under comparison.

---

## 8. Does the calibration still hold?

### What was calibrated

**[measured]** `compareFingerprints.ts`:

- `MATCH_PERCENT_THRESHOLD = 20` — at least 20% of common achievements share an identical timestamp.
- `MIN_COMMON_ACHIEVEMENTS = 200` — below this the sample is too small to judge; "a fresh alt with a
  handful of account-wide achievements would otherwise score 100%".

### The evidence

**[measured]** Four live accounts. Full pairwise sweep of one 30-character guild roster (435 pairs):

```
5335 identical / 6395 common (83.4%)  Mangashift <-> Skadimg
5242 identical / 6088 common (86.1%)  Skâdi      <-> Skadimg
2852 identical / 3886 common (73.4%)  Katzeth    <-> Kázeth
2324 identical / 3505 common (66.3%)  Tämmy      <-> Alyïssa

distribution: min 0 | p50 6 | p90 99 | p99 3465 | max 5335
```

Three applicant sweeps:

| Applicant | Roster | Scanned | Result |
| --- | --- | --- | --- |
| Hitoshura-Ravencrest | `Goodlife`, 429 members / 21 realms | 417 | 1 match at 45.0% (2069/4600); next highest 1.6%; p50 0.00, max 44.98 |
| Driptinus-Argent Dawn | `Rancour-Draenor` | 313 | 3 matches at 82.8%, 73.8%, 49.6%; noise ceiling 3.0% |
| Yawnersw-Silvermoon | `Rancour-Draenor` | — | 9 matches; **weakest genuine match 31.0%** |

The separation is the point: **noise ceiling 3.0%, weakest true match 31.0%, nothing observed between.**
In the pairwise distribution the gap runs from 99 identical to 2,043 with no occupant. The 20% threshold
sits an order of magnitude above the noise with a 1.55× margin below the weakest true positive. An
earlier draft at 30% would have missed `Yawners-Draenor` by one point.

Independently corroborated: Driptinus's own Raider.IO `discord_profile` reads `ictinus`, and the
fingerprint surfaced `Ictinus-Argent Dawn` at 49.6% without being told. **[measured]**

### Verdict

**Nothing found in the current API invalidates the calibration, and the mechanism is now better
evidenced than it was when the thresholds were set.**

| Dependency | Status |
| --- | --- |
| Endpoint path and namespace | Unchanged **[documented]** |
| Client-credentials access | Unchanged **[documented]** |
| Rate limits (36,000/h, 100/s) | Unchanged **[documented]** |
| `completed_timestamp` present per achievement | Confirmed **[staff]**, absent from the reference **[documented]** |
| Timestamps account-wide across an account's characters | Confirmed **[staff]** for *both* achievement types |
| DOCATO can make timestamps character-scoped, undetectably | Confirmed **[staff]**; option apparently removed in 11.1.0 **[community]** |

The bot calibrated empirically without ever citing the Blizzard staff post. This note supplies the
missing justification — and finds the bot's own comment slightly *understates* the mechanism, since
character achievements carry account-wide timestamps too.

Three limits on the evidence, stated plainly:

- **Four accounts is a small sample**, all EU, all found via guild rosters, all on characters mature
  enough to have thousands of achievements.
- **The margin is asymmetric.** ~10× headroom below the threshold, 1.55× above it. A modest downward
  shift in genuine-match rates costs true positives long before a rise in noise costs false ones.
- **No cross-region pair was ever tested**, because the sweep is region-locked by construction. §7's
  region conclusion is documentation-derived, not calibration-derived.

### An anomaly worth chasing

If `completed_timestamp` is account-wide for every achievement, two characters on one account should
share an *identical* timestamp for every common achievement ID — roughly **100%**, not the observed
31–86%. That discrepancy is unexplained by any source, and it is worth understanding because it is
precisely the margin that separates the 20% threshold from the weakest true match.

Three candidate explanations, all **[estimated]**:

1. **Snapshot staleness.** Character resources update on logout **[documented]**. A parked alt's
   document is frozen at its last logout, so achievements the account earned afterwards carry the alt's
   older value or are absent. This would depress the match rate exactly in proportion to how long the
   alt has been idle — and `Yawners-Draenor`, the weakest true match at 31%, is plausibly the most
   dormant character in the sample.
2. **Partial DOCATO.** A character with the flag set returns character-scoped timestamps for everything,
   which would produce a near-zero rather than a 31% score, so this explains outliers rather than the
   general spread.
3. **The 2020 staff description has drifted** in the six years since, or was always simplified.

If (1) dominates, the match rate is a function of alt dormancy, and **the threshold's real job is to
tolerate stale alts** — which reframes what a future recalibration should sample: pairs spanning a range
of last-login dates, not just any four accounts. That is a cheap experiment and a genuinely useful one.

### What would move the thresholds

**[estimated]** — reasoning, not measurement:

1. **A mass backfill of newly account-wide achievements.** The highest-impact risk, and it cuts the
   opposite way from the intuitive reading. Making more achievements account-wide does not create
   sharing between *different* accounts, so it does not raise the noise floor — it raises true-match
   rates and strengthens the test. The danger is a **migration**: if Blizzard converts a block of
   achievements and stamps them all with the same patch-day timestamp, **every character in the game
   shares those identical timestamps**, and unrelated pairs suddenly share hundreds. That inflates the
   noise ceiling straight through the 20% threshold. Warband-style account unification is exactly the
   kind of change that could do it. **Any recalibration must re-measure the noise ceiling, not just the
   true-match rate** — measuring only true matches would miss this entirely.
2. **Timestamps becoming per-character.** The mechanism collapses; no threshold saves it. Low
   likelihood — it would be a visible in-game regression — but it is the single point of failure.
3. **Timestamp granularity coarsening.** If timestamps were ever rounded to the day, unrelated
   characters playing the same content in the same window would collide and noise would spike.
   Currently millisecond epoch **[measured]**.
4. **Sweeping fresher populations.** The 200-common floor exists for this. A sweep biased toward new or
   boosted characters excludes more than it matches — correct behaviour that reads as "found nothing".
5. **A change in how incomplete achievements are represented.** The bot filters on
   `completed_timestamp` truthiness. If Blizzard began emitting `0` or `null` instead of omitting the
   field, `if (a.completed_timestamp)` still holds — but a reimplementation checking
   `'completed_timestamp' in a` would break silently and match everything. **Filter on truthiness, as
   the bot does, and test it.**

### Recommendation

Re-run the calibration rather than inherit it, but expect to confirm it. Two known same-account pairs
plus one full roster sweep would reproduce the noise-ceiling and weakest-match figures cheaply, and
would be the first evidence gathered after the 11.1.0 DOCATO removal rather than before it. Sample
pairs across a range of last-login dates to test the dormancy hypothesis above. Keep the thresholds as
constants with the calibration evidence in the comment, exactly as `compareFingerprints.ts` does — the
recorded reasoning is what makes them safe to change later.

---

## Bottom line

**Is the mechanism intact?** Yes — and it is on firmer ground than the existing implementation knew. The
endpoint, path, namespace, client-credentials access, and rate limits are all exactly what
SeriouslyCasualBotV2 assumes, verified against Blizzard's live documentation today. Better, a verified
Blizzard developer has stated explicitly that `completed_timestamp` reflects completion "by any
character on the account" — for *both* account-wide and character achievements, meaning the whole
timestamp set carries the signal rather than a subset. The caveat is that Blizzard publishes **no
response schema for any WoW endpoint**, so this is an undocumented implementation detail with no
compatibility commitment behind it, evidenced by a 2020 forum post and four live accounts. Build on it;
do not record it as guaranteed, and pin it with integration tests.

**What does one fingerprint cost?** One HTTP request — 0.0028% of the documented 36,000/hour budget —
and **~333–400 ms of amortised wall time** at concurrency 8 **[measured]**, yielding ~24 req/s. Storage
is ~82 KB raw, ~34 KB compressed **[measured]**. The 333 ms is a throughput-derived mean, not an isolated
single-request latency, and the isolated figure has never been measured by anyone.

**Biggest uncertainty: the response weight.** Every cost figure here is a *request* count or a
*derived-data* size; nobody has measured the bytes on the wire, and the **[estimated]** 1–4 MB range is
inference from a 21-byte-per-pair reconstruction, corroborated only by a 2021 forum remark that the
response is "large" and by that endpoint being 4–60× slower than its siblings. If it sits at the top of
that range, a 3,000-character sweep moves ~12 GB and **bandwidth, not the rate limit, becomes the binding
constraint** — which would change the architecture rather than just the tuning. That single measurement
should be the first thing the prototype takes. Runner-up: whether an account with Battle.net "Share Game
Data" disabled returns 403, 404, or an empty document, since that is now the only live privacy mechanism
and the existing implementation collapses all three cases into "unknown".

---

## Sources

All retrieved **6 August 2026**.

### Primary — Blizzard official documentation

| Page | URL |
| --- | --- |
| Getting Started (incl. Throttling) | https://community.developer.battle.net/documentation/guides/getting-started |
| OAuth — Client Credentials Flow | https://community.developer.battle.net/documentation/guides/using-oauth/client-credentials-flow |
| OAuth — Authorization Code Flow | https://community.developer.battle.net/documentation/guides/using-oauth/authorization-code-flow |
| Regionality and APIs | https://community.developer.battle.net/documentation/guides/regionality-and-apis |
| WoW Profile APIs reference | https://community.developer.battle.net/documentation/world-of-warcraft/profile-apis |
| WoW Game Data APIs reference | https://community.developer.battle.net/documentation/world-of-warcraft/game-data-apis |
| WoW — Namespaces | https://community.developer.battle.net/documentation/world-of-warcraft/guides/namespaces |
| WoW — Known Issues | https://community.developer.battle.net/documentation/world-of-warcraft/guides/known-issues |
| Old host, confirmed 301 | https://develop.battle.net/documentation/world-of-warcraft/profile-apis |

The rendered pages are SPA shells; the cited content was read from the portal's content API at
`https://community.developer.battle.net/api/pages/content/{path}.json`,
`.../api/pages/pages/{path}.json`, and `.../api/pages/navigation/{path}.json`.

### Primary — Blizzard staff

- **Araspir, "Blizzard Developer", 18 May 2020** — *Character Achievements API: When is an achievement
  "completed"?*
  <https://us.forums.blizzard.com/en/blizzard/t/character-achievements-api-when-is-an-achievement-completed/7171>
  Staff status verified from the raw Discourse JSON (`?.json` suffix): `staff: true`, `moderator: true`,
  `primary_group_name: "developer"`, `user_title: "Blizzard Developer"`.

### Secondary — community forum reports (no staff confirmation; labelled inline)

- <https://us.forums.blizzard.com/en/wow/t/display-only-character-achiev-to-others-is-gone/2066215>
  (26 Feb – 18 May 2025, 13 posts, no staff reply) — DOCATO removal, forced clearing on login, and the
  Battle.net account-level "Share Game Data" setting.
- <https://us.forums.blizzard.com/en/blizzard/t/wow-profile-achievements-endpoint-slow/14365>
  (6 January 2021) — response size and gzip effect, qualitative only.
- <https://us.forums.blizzard.com/en/blizzard/t/403-character-statistics-api/47246> (September 2023) —
  403 caused by a malformed namespace.
- <https://us.forums.blizzard.com/en/blizzard/t/403-404-classic-classic1x/53959> (to 25 April 2025) —
  403/404 inconsistencies.

### SeriouslyCasualBotV2 — source of every [measured] figure

`Erilla/SeriouslyCasualBotV2`, read-only, working copy at `G:/repos/SeriouslyCasualBotV2`.

| File | Contributes |
| --- | --- |
| `src/services/blizzard.ts` | Endpoint construction, token caching, cache TTLs and disk-pressure measurements, failure contract |
| `src/functions/applications/alts/compareFingerprints.ts` | Both thresholds and the calibration summary |
| `src/functions/applications/alts/discoverAlts.ts` | `ALT_CAPS`, the 333 ms per-call figure, the 24 req/s measurement, rate-limit reasoning, region-locking by construction |
| `tests/unit/blizzardFingerprint.test.ts` | Observed response shape, ms-epoch timestamps, incomplete-achievement handling, compression measurements |
| `docs/services.md` | Documented service contract |
| `docs/superpowers/specs/2026-08-03-applicant-mythic-logs-and-alts-design.md` | Full calibration data across four accounts, rate-limit budget table, caps |
| `docs/superpowers/plans/2026-08-04-applicant-intel.md` | Failure-contract table, the rename/transfer 404 observation, caching rationale |

### Could not verify from any source

`total_quantity` / `total_points` fields; any response size in bytes; the total WoW achievement count;
the 403-vs-404 contract; official confirmation of the DOCATO removal; isolated single-request latency.
