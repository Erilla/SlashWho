# Raider.IO raid-progression and guild-history evidence fields

**Question.** Which raid-progression and guild-history evidence fields does the
Raider.IO API actually expose at the access tier SlashWho uses, and at what
request cost? Specifically: per-boss Mythic kill dates, per-tier raid
progression, the guild attached to each kill, Cutting Edge, and which `fields=`
parameters supply these.

**Scope.** Raider.IO only. Warcraft Logs is out of scope here — issue #46
settles it as in scope but sequenced last. Deployment, credentials, Discord
configuration, and monitoring are excluded.

## Revisions and method

- **Documented API:** the Raider.IO Developer API OpenAPI/Swagger document at
  [`https://raider.io/swagger.json`](https://raider.io/swagger.json), reporting
  `info.version` **0.62.5**, retrieved 2026-08-26. The human-facing playground
  at [raider.io/api](https://raider.io/api) answers HTTP 403 to a plain
  programmatic fetch; the Swagger document behind it does not, and is the
  machine-readable form of the same page. The description field of that document
  also advertises an OpenAPI 3.0 rendering at `/openapi.json`.
- **Live verification:** unauthenticated `GET` requests issued 2026-08-26
  against `https://raider.io`, a handful in total. Where this note says
  *observed*, it means a live response on that date, and the request is quoted
  so it can be repeated. Where it says *documented*, it means the Swagger
  document declares it and no live call was made.
- **Upstream:** `Erilla/SeriouslyCasualBotV2` at
  [`aed4021478030233b39da099d57ac68642e835ed`](https://github.com/Erilla/SeriouslyCasualBotV2/tree/aed4021478030233b39da099d57ac68642e835ed),
  the same revision as the
  [2026-08-15 applicant-intel comparison](./2026-08-15-seriouslycasualbotv2-applicant-intel.md).
- **Local baseline:** SlashWho
  [`6108d2f7923f5200ff4c4c890f82203de3859376`](https://github.com/Erilla/SlashWho/tree/6108d2f7923f5200ff4c4c890f82203de3859376)
  (`origin/main`), checked locally on 2026-08-26.
- This note feeds issue #46's settled shape and answers ticket #47. It records
  availability and cost. It does not recommend an implementation.

## The finding that reframes the question

The ticket asks what is available "at the access tier SlashWho uses" and which
`fields=` parameters supply it. **SlashWho does not use the documented API at
all, and `fields=` does not exist on the tier it is on.**

`packages/raiderio/src/client.ts` calls exactly two hosts-relative paths:
`/api/characters/{region}/{realm}/{name}` and
`/api/user/view-characters?name={…}`. Neither is `/api/v1/…`; neither appears in
the Swagger document; and `name` is the only query parameter the client ever
sets. A repository-wide search for `fields=` and for `access_key` over
`packages/` and `apps/` returns nothing.
[client.ts](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/packages/raiderio/src/client.ts),
[normalize.ts](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/packages/raiderio/src/normalize.ts),
[types.ts](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/packages/raiderio/src/types.ts).

The `characterDetails` and `viewUserCharactersApi` envelopes the normaliser
parses are the shapes of raider.io's own website endpoints. Upstream reaches the
same two paths and names the tier explicitly, in a module kept separate from its
documented-API client precisely so a break in one cannot open the circuit for
the other:

> Raider.IO's *internal* API — the endpoints its own site calls. These are
> undocumented and may change without notice…
>
> — [`src/services/raiderioInternal.ts`](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/services/raiderioInternal.ts)

So there are two tiers in play, not one, and the evidence fields are split
across them. The rest of this note answers each sub-question against both.

## Tier 1 — the documented API (`/api/v1`)

`GET /api/v1/characters/profile` takes `region`, `realm`, `name`, an optional
`access_key`, and an optional comma-separated `fields`. The `fields` values
relevant here are:

| Field | What it supplies |
| --- | --- |
| `guild` | The character's **current** guild only: `{name, realm}`. Observed. |
| `raid_progression` | Per-raid counts. Defaults to the current expansion; accepts `:<expansion_id>`, `:<raid-slug>`, `:current-expansion`, `:previous-expansion`, `:current-tier`, `:previous-tier`, repeatable by colon. |
| `raid_achievement_curve:<slug>[:<slug>…]` | AOTC / Cutting Edge status for the named raid slugs. |
| `raid_achievement_meta:<tierN>` | Raid meta-achievement status per tier. Not exercised. |

`raid_progression` resolves to `OverallRaidProgression`, a map of raid slug to
`RaidProgression`, whose entire declared property set is `summary`,
`expansion_id`, `total_bosses`, `normal_bosses_killed`, `heroic_bosses_killed`,
`mythic_bosses_killed`. **There is no date and no guild anywhere in that
object.** Observed live:

```
GET /api/v1/characters/profile?region=eu&realm=tarren-mill&name=Justwait
    &fields=raid_progression:9:10:11
→ 200, 2,643 bytes, 14 raids spanning three expansions
  "nerubar-palace": {"summary":"1/8 H","expansion_id":10,"total_bosses":8,
                     "normal_bosses_killed":1,"heroic_bosses_killed":1,
                     "mythic_bosses_killed":0}
```

`raid_achievement_curve` is the notable one. The Swagger document declares it as
an accepted `fields` value but declares **no matching property** on
`ViewCharacterProfileResponse` — the response schema stops at
`mythic_plus_dungeon_run_counts`. Its shape is therefore undocumented and was
established by observation:

```
GET /api/v1/characters/profile?region=eu&realm=tarren-mill&name=Justwait
    &fields=guild,raid_progression,raid_achievement_curve:manaforge-omega:liberation-of-undermine:nerubar-palace
→ 200, 1,490 bytes
  "raid_achievement_curve": [
    {"raid":"manaforge-omega",       "aotc":"2025-10-21T17:16:00.000Z",
                                     "cutting_edge":"2025-10-21T17:16:00.000Z"},
    {"raid":"liberation-of-undermine","aotc":"2025-07-21T18:40:00.000Z",
                                     "cutting_edge":"2025-07-21T18:40:00.000Z"},
    {"raid":"nerubar-palace",        "aotc":"2024-09-24T19:29:32.000Z",
                                     "cutting_edge":"2025-02-04T17:59:00.000Z"}
  ]
```

A raid with AOTC but no Cutting Edge omits the `cutting_edge` key rather than
nulling it — observed on a second character (`us/skullcrusher/Ulsoga`), whose
entries carried `aotc` alone.

**A caveat that matters for how CE may be presented.** In the response above,
`raid_achievement_curve` reports Cutting Edge for `nerubar-palace` while the
same response's `raid_progression` reports that raid as `1/8 H` with
`mythic_bosses_killed: 0`. The achievement date and this character's kill record
disagree. The likeliest explanation is that AOTC/CE are account-wide
achievements in WoW and Raider.IO surfaces the account's credit on any character
of that account — but **I did not verify Raider.IO's scoping rule from a primary
source, and state it here as inference, not fact.** The safe reading for
SlashWho is that `raid_achievement_curve` evidences *the account* earned CE, not
that *this character* was in the raid, and not which guild it was earned with.

Also documented but not useful for this question:

- `GET /api/v1/guilds/boss-kill` returns `{kill, roster}` with `pulledAt`,
  `defeatedAt`, `durationMs` and a roster of characters. It is keyed on
  `region + realm + guild + raid + boss + difficulty` — a *guild-first* lookup.
  Deriving a character's guild history from it would mean already knowing every
  candidate guild, which is the thing being derived. It does not invert.
- `GET /api/v1/raiding/static-data?expansion_id=N` returns raid slugs, names,
  encounters and `starts`/`ends` per region. This is how upstream obtains tier
  end dates.
  [`raidTierEnds.ts`](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/functions/applications/mythic-logs/raidTierEnds.ts)
  notes there is no "list expansions" call, so it climbs expansion ids from 9
  until one comes back empty, capped at 6.

## Tier 2 — the internal API (the tier SlashWho is already on)

The endpoint that carries the evidence is
`GET /api/characters/{region}/{realm}/{name}/raid-progress?tier={ordinal}`. It
is not in the Swagger document. Upstream consumes it in
[`getMythicKillDates`](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/services/raiderioInternal.ts),
which types the parts it needs as `characterRaidProgress.raidProgress[]` with
`raid` and `encountersDefeated.mythic[]` of `{slug, firstDefeated, guild}`.

Observed live, `GET /api/characters/eu/tarren-mill/Justwait/raid-progress?tier=35`
(8,451 bytes). Each `raidProgress` entry carries:

```
raid, aotc, cuttingEdge, encountersDefeated, weekRanges, progress, tier,
raidWeekAotC, raidWeekCuttingEdge
```

`encountersDefeated` is keyed `normal` / `heroic` / `mythic`, and each entry in
those arrays is per boss:

```
{"slug":"imperator-averzian",
 "firstDefeated":"2026-03-20T10:23:46.000Z",
 "lastDefeated":"2026-03-20T10:23:46.000Z",
 "numKills":1, "itemLevel":233, "bossIcon":"…", "loggedEncounterId":292436,
 "guildId":1047044,
 "guild":{"id":1047044,"name":"Echo","displayName":"Echo","faction":"horde",
          "realm":{"slug":"tarren-mill","name":"Tarren Mill",…},
          "region":{"slug":"eu",…},"path":"/guilds/eu/tarren-mill/Echo",…},
 "raidWeek":1,"lastRaidWeek":1}
```

That single payload answers three of the ticket's five questions at once:
per-boss first-kill dates, the guild each kill happened with, and — via the
per-raid `aotc` / `cuttingEdge` timestamps — Cutting Edge, without needing the
documented API at all.

**One divergence from upstream's recorded observation, stated plainly.**
`getMythicKillDates` de-duplicates by boss slug because, it says, "the endpoint
returns the same raid under EVERY tier ordinal at or after it — verified live:
`tier-mn-1`'s 9 kills came back under all of tiers 35..28". My 2026-08-26 probe
did **not** reproduce that: tiers 35, 34, 33 and 32 each returned exactly one
raid (`tier-mn-1`, `manaforge-omega`, `liberation-of-undermine`,
`nerubar-palace` respectively), and tiers 40 and 41 returned an empty list. I
cannot say whether the endpoint changed, whether the behaviour is
character-dependent, or whether the tier ordinals differ. Either way the
de-duplication upstream applies is harmless, and any SlashWho implementation
should keep it rather than trust one probe.

## Answers

| Sub-question | Documented `/api/v1` | Internal (SlashWho's tier) |
| --- | --- | --- |
| Per-boss Mythic kill dates | **No.** `raid_progression` carries counts only. | **Yes.** `firstDefeated` and `lastDefeated` per boss, plus `numKills`. Observed. |
| Raid progression per tier | **Yes.** `fields=raid_progression`, per-raid `summary` and per-difficulty kill counts. | Yes, and per boss rather than per count. |
| Guild attached to each kill | **No.** `fields=guild` gives the *current* guild only. | **Yes.** A full guild object on every encounter entry, so guild stints are derivable. Observed. |
| Cutting Edge | **Yes.** `fields=raid_achievement_curve:<slug>` → `{raid, aotc, cutting_edge}` ISO timestamps. Response shape undocumented; observed. Likely account-scoped (see caveat). | **Yes.** Per-raid `aotc` / `cuttingEdge` on each `raidProgress` entry. Observed. |

Worth recording: upstream does **not** use `raid_achievement_curve`. It derives
CE itself in
[`determineCE`](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/functions/guild-info/determineCE.ts)
— full Mythic clear, with the final boss killed before the tier's EU end date
from `raiding/static-data`, an officer override winning over Raider.IO's own end
date — and attributes CE to a *guild stint* in
[`aggregateGuildHistory`](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/functions/applications/mythic-logs/gatherMythicLogs.ts).
That is strictly more information than `raid_achievement_curve` gives: the
achievement field says the account has CE; the derivation says *which guild* it
was earned with. The two are not interchangeable, and which one SlashWho wants
depends on whether the officer question is "do they have CE" or "who did they
get CE with".

## Request cost

**Documented API: one request per character, regardless of how many fields.**
`fields` is a single comma-separated list on one `GET`, and every value
requested came back in one body. The multi-expansion probe above returned 14
raids across three expansions in **2,643 bytes**, and the combined
`guild,raid_progression,raid_achievement_curve:<3 slugs>` probe in **1,490
bytes**. Extra fields cost a larger response, not extra requests.

**Internal API: one request per character per tier ordinal.** There is no
`fields` parameter and no way to ask for more than one tier per call — the tier
is the query parameter. Upstream fans these out concurrently at
`concurrency = tierOrdinals.length` and caps the sweep at `MAX_TIERS = 5` tiers
of rendered output. Its own measurements, recorded in comments at the upstream
revision:

- The internal `raid-progress` call measured **1,029 ms**, against 333 ms for
  Blizzard and 299 ms for Warcraft Logs.
- Eight serial calls per character made it "**~52% of a whole job**", which is
  why the tier fan-out is concurrent.
- Callers must pace **between characters** by
  `RAIDERIO_INTERNAL_PACE_MS = 700`, at
  `RAIDERIO_INTERNAL_CHARACTER_CONCURRENCY = 4`. This is not politeness: the
  module records that unpaced calls "drop payloads silently — an unpaced sweep
  once lost a character's kill data and reassigned five first kills to the wrong
  character".

So for a dossier over `N` discovered characters and `T` tier ordinals, the
internal tier costs `N × T` requests where the documented tier costs `N`. At
upstream's 8 tiers and the 18–19 characters its measured job swept, that is
roughly 150 requests for the kill history alone.

Note also that a silent partial failure here is not a cosmetic defect. Upstream
returns `null` for the whole character when *any* tier fetch fails, because an
empty list reads as "this character killed nothing", which moves first-kill
credit to a different character. Any SlashWho implementation inherits that
requirement.

## Rate limiting, authentication and acceptable use

The Swagger document's description states that unauthenticated requests are rate
limited; that exceeding the limit yields HTTP 429 with `Retry-After` in whole
seconds plus `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset`; and that higher rates are unlocked by registering an
application at [raider.io/settings/apps](https://raider.io/settings/apps) and
passing `access_key`. It publishes **no numeric limit** for either tier.

On the successful unauthenticated `/api/v1` responses observed on 2026-08-26, no
`X-RateLimit-*` headers were present. I did not provoke a 429 and so cannot
confirm the documented 429 behaviour from observation. SlashWho's client already
reads `Retry-After` and maps it to a transient failure with `retryAfterMs`
([`client.ts`](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/packages/raiderio/src/client.ts)),
so the documented back-off contract is already honoured on whichever tier
returns it.

Two governance points belong on the record rather than in an implementation
review:

1. The same description carries an **Acceptable Use** clause: "*Automated
   scraping beyond the published endpoints is prohibited.*" Every Raider.IO call
   SlashWho makes today is to an unpublished endpoint, and everything in Tier 2
   above would extend that dependency rather than begin it. This note does not
   judge that; it records that the clause exists and that the exposure is
   pre-existing.
2. The description also requires that public-facing applications using this data
   **link back to raider.io**.

## What this implies (availability and cost only)

- **Guild-history evidence is feasible from Raider.IO alone**, without Warcraft
  Logs. The kill payload names the guild on every kill, so guild stints, their
  date ranges, and kill counts come out of data already being fetched for kill
  dates — upstream's comment that this "costs no extra requests" is accurate
  *given* the kill dates are being fetched at all.
- **The cost is the tier fan-out, not the fields.** Nothing here is gated behind
  a paid tier, an `access_key`, or an OAuth flow — the contrast issue #46 draws
  with Warcraft Logs holds. The cost is `N × T` unauthenticated requests at
  ~1 s each, paced at 700 ms between characters with concurrency 4.
- **Cutting Edge has two routes with different meanings.** One documented
  request per character yields a dated account-level CE. Deriving it per guild
  stint, as upstream does, needs the internal kill history plus
  `raiding/static-data` tier ends. Which is wanted is a shape question for #46,
  not an availability question.
- **The `fields=` framing in the ticket applies only to Tier 1.** If SlashWho
  wants per-tier progression summaries or account-level CE, `fields=` is the
  mechanism and it is free of extra round trips. If it wants dated, guild-attributed
  per-boss kills, `fields=` is not involved at all.

## Explicitly not verified

- Raider.IO's scoping rule for `raid_achievement_curve` (account-wide vs
  character). Inferred from one observation; no primary source found.
- The numeric rate limits for either tier, authenticated or not. Not published.
- The documented 429 / `X-RateLimit-*` behaviour. Not provoked.
- Whether the internal `raid-progress` endpoint repeats a raid across tier
  ordinals, as upstream recorded and this probe did not reproduce.
- `raid_achievement_meta`. Documented as a `fields` value; not exercised.
- Any claim about the internal endpoints' stability. They are undocumented by
  definition and upstream treats them as liable to change without notice.
