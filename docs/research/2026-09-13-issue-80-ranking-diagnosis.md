# Issue #80: historic boss ranking diagnosis

Checked 2026-09-13 against main bced97f and the public
[Rinn dossier API](https://web-test-7765.up.railway.app/api/dossiers/eu/silvermoon/rinn).

## Reproduced boundary

Calling the unmodified Raider.IO gateway for `nerubar-palace/queen-ansurek`
returned `{kind: "limitation", code: "schema_drift"}` despite HTTP 200.
The live response contains an **array** in `encountersDefeated`; the parser
expected an object. The application then replaced this diagnostic with
`unavailable` and omitted it from the dossier limitations.

The recorded fixture at `packages/raiderio/src/fixtures/queen-ansurek-rankings.json`
retains only the first two leaderboard rows, their guild identities/ranks and
first three encounter records. Other guild metadata and stream information
were removed; retained values are unchanged. Source:
[published world Mythic Queen Ansurek leaderboard](https://raider.io/api/v1/raiding/boss-rankings?raid=nerubar-palace&boss=queen-ansurek&difficulty=mythic&region=world).

Liquid's records include 2024-09-29T07:02:27Z, a duplicate one second later,
and a later kill on 2024-10-21. Echo's earliest record is
2024-09-30T12:07:25Z, rank 2. The normalizer must emit one row per guild,
using the earliest timestamp for the exact requested boss. A later player kill
must not inherit the guild's first-kill progression rank. The existing unique
guild/realm/region match and two-minute tolerance remain unchanged.

## Concrete dossier evidence and coverage

Rinn's dossier includes linked character Ryan's Queen Ansurek kill with Rancour
(Draenor) at 2024-12-08T21:25:34.557Z, report `ZhMQPa3KvFb2VJXH`, fight 29.
The corrected gateway successfully returns 50 rows, with no Rancour row.
It likewise returns 50 Sire Denathrius rows with no SeriouslyCasual row for
Ryan's 2021-06-23T21:20:31.636Z kill. These ranks remain unknown.

Ryrn's Sszorak kill with Rancour at 2026-09-07T18:42:21.451Z was skipped
because The Venomous Abyss had no Raider.IO raid mapping. The
[published API contract](https://raider.io/swagger.json) lists
`the-venomous-abyss`, `the-tidebound-grotto`, and `sporefall`; these now map
to their existing Journal raid IDs. A live Sszorak world leaderboard request
returned 50 rows, also with no Rancour match. Unpublished raid names remain
unsupported. The documented endpoint has no pagination parameter; a missing
guild cannot be assigned a rank by extrapolating its kill date.

## Cache and diagnostics

The gateway's permanent map would bypass the application's 15-minute TTL.
It has been removed; the bounded application cache still deduplicates requests
and retains only successful normalized results. Failures retain their typed
codes, emit a code-only diagnostic, remain uncached, and produce a limitation
explicitly scoped to boss world ranks. A successful unmatched lookup produces
no source-failure limitation.

## Verification

The gateway probe failed before the fix and returned 50 normalized rows after
the fix. Regression tests failed before implementation and cover the recorded
array, unordered duplicate/later records, unrelated boss slugs, unmatched guild,
realm and region, later player kills, ambiguous rows, failed-source disclosure,
failure retries, and newly supported raid mappings. These checks validate the
parser and conservative rank semantics; they do not establish a rank for a
guild absent from the retained leaderboard. Deployment verification is required
before closing #80.
