# Raid current-content windows

The dossier accepts Mythic boss evidence only when its timestamp is inside the
current-content window for its Journal raid. The source catalogue does not
include season timing, so the domain catalogue resolves these windows from two
sources and keeps the widest window they support.

## Why two sources

Reviewed windows were transcribed by hand from Blizzard's season and raid
announcements. They are accurate about _Mythic_ unlock, which is the difficulty
being judged, but they only ever covered the tiers someone had reviewed. That
left every raid older than Nerub-ar Palace with no window, and a raid without a
window has all of its kills withheld: one live dossier was discarding 968 kills,
646 of them for a single character, while the wipes from the same reports
remained visible. A reviewer saw raiders who had apparently only ever wiped.

Raider.IO's raiding static data closes that gap. It publishes each raid's
opening and closing per region for every raid back to Legion, and it is
generated rather than transcribed, so a new tier cannot be missed by omission.
It is not a straight replacement: its `starts` is the raid's first opening
rather than the Mythic unlock, and it does not reach back past Legion.

## Boundary policy

Windows are half-open UTC intervals: a kill at `startsAt` is included and a kill
at `endsAt` is excluded.

The resolved window is the **earliest known opening and the latest known
close** across both sources. The two boundaries are deliberately not symmetric:

- **Start — the earlier wins.** A start earlier than the true Mythic unlock
  cannot admit anything, because no Mythic kill predates Mythic opening. A start
  later than the unlock withholds real kills. So too early is free and too late
  is harmful.
- **End — the later known value wins.** An end later than the true close admits
  legacy farm clears; an end earlier than the close withholds real progression
  kills. The latter is the worse failure, so the later end wins.
- **A null end is unknown, not infinite.** It yields to any dated close and
  survives only when neither source has one. A reviewed `null` recorded that no
  close had been reviewed yet, so treating it as permanent would admit farm
  clears once the real close became known.

Reviewed dates are stored at `00:00:00Z` because Blizzard publishes unlock
_dates_ rather than one global instant valid in every region, which keeps the
boundary reproducible. Generated windows instead take the union across
Raider.IO's regional timestamps, so a kill is never judged legacy because
another region's reset landed first.

A raid with no window from either source is unknown: its evidence is withheld
and reported as `current_content_window_unknown`; it is never described as a
missing kill. Evidence outside a resolved window is withheld and reported as
`current_content_evidence_withheld`. Both are reported once per character and
reason rather than once per kill, because a farming alt otherwise produces
hundreds of identical rows that bury every other limitation.

## Generated windows

Regenerate with:

```
SLASHWHO_RAID_CURRENT_CONTENT_WINDOW_OUTPUT=packages/domain/src/raid-current-content-windows.generated.json \
  npm run generate:raid-current-content-windows
```

The generator reads `GET /api/v1/raiding/static-data?expansion_id=N` from
Raider.IO, which requires a `user-agent` header and answers `400` for
expansions it does not serve. Expansion ids 6 (Legion) through 11 (Midnight)
return data; earlier expansions do not, so **Siege of Orgrimmar (`369`),
Highmaul (`477`), Blackrock Foundry (`457`) and Hellfire Citadel (`669`) have no
generated window**. They are listed in `raidsWithoutCurrentContentWindow`, and
their Mythic kills stay withheld until reviewed windows are added by hand.

Raider.IO marks a season with no announced close using a far-future placeholder
(`2030-01-01T00:00:00Z`), which the generator records as an open-ended window
rather than an expiry date nobody published.

Raider.IO lists the Fated and Awakened re-runs as separate raids. No Journal id
maps to those slugs, so a Fated Sepulcher clear currently counts as legacy
rather than as the current content of its own season. Fixing that needs more
than one window per raid.

## Reviewed windows

| Journal raid                     | Reviewed window                                  |
| -------------------------------- | ------------------------------------------------ |
| Nerub-ar Palace (`1273`)         | `2024-09-17T00:00:00Z` to `2025-03-04T00:00:00Z` |
| Liberation of Undermine (`1296`) | `2025-03-04T00:00:00Z` to `2025-08-12T00:00:00Z` |
| Manaforge Omega (`1302`)         | `2025-08-12T00:00:00Z` to `2026-03-17T00:00:00Z` |
| The Voidspire (`1307`)           | `2026-03-24T00:00:00Z` onward                    |
| March on Quel'Danas (`1308`)     | `2026-03-31T00:00:00Z` onward                    |
| The Dreamrift (`1314`)           | `2026-03-24T00:00:00Z` onward                    |
| Sporefall (`1305`)               | `2026-05-20T00:00:00Z` onward                    |
| The Tidebound Grotto (`1317`)    | `2026-08-19T00:00:00Z` onward                    |
| The Venomous Abyss (`1320`)      | `2026-08-01T00:00:00Z` onward                    |

The War Within dates come from Blizzard's season and raid announcements:
[Season 1](https://worldofwarcraft.blizzard.com/en-us/news/24137817/the-war-within-season-1-now-live),
[Season 2](https://worldofwarcraft.blizzard.com/en-us/news/24178759), and
[Season 3](https://worldofwarcraft.blizzard.com/en-gb/news/24215413).
Midnight dates come from Blizzard's [Season 1 schedule](https://worldofwarcraft.blizzard.com/en-gb/news/24266321/midnight-season-1-mythic-now-available),
[March on Quel'Danas availability](https://worldofwarcraft.blizzard.com/en-gb/news/24243864),
and [Sporefall announcement](https://worldofwarcraft.blizzard.com/en-us/news/24272110).

These are no longer the only source, so an open reviewed window no longer has
to be closed by hand before a superseding season's evidence is admitted — the
generated close supplies it. Adding a reviewed window is still worthwhile when
Blizzard's Mythic unlock is later than Raider.IO's raid opening, or for the four
pre-Legion raids Raider.IO does not serve. Both maps live in
`packages/domain/src/raid-catalogue.ts`.

## Pre-Legion raids

Raider.IO's raiding static data answers 400 for expansions before Legion, so the
four Warlords-and-earlier raids have no generated window and never will. They
are curated in `preLegionContentWindows`:

| Raid                       | Window                                           |
| -------------------------- | ------------------------------------------------ |
| Siege of Orgrimmar (`369`) | `2013-09-10T00:00:00Z` to `2014-12-02T00:00:00Z` |
| Highmaul (`477`)           | `2014-12-02T00:00:00Z` to `2015-02-03T00:00:00Z` |
| Blackrock Foundry (`457`)  | `2015-02-03T00:00:00Z` to `2015-06-23T00:00:00Z` |
| Hellfire Citadel (`669`)   | `2015-06-23T00:00:00Z` to `2016-09-20T07:00:00Z` |

`startsAt` is the raid's opening at `00:00:00Z`, the same reproducible-boundary
convention as the reviewed windows. **`endsAt` is the next tier's opening,
recorded as exactly that** — not a separately sourced closing date. It is the
same quantity Raider.IO's `ends` approximates, and naming it honestly is worth
more than implying a precision we do not have. Hellfire Citadel therefore closes
where the generated snapshot opens The Emerald Nightmare
(`2016-09-20T07:00:00Z`), so the curated and generated schedules meet at a seam
rather than overlapping.

Leaving these four unwindowed was a live defect, not a cosmetic gap: an
unwindowed raid reads as `unknown` to `raidTierConclusion`, so it can never be
marked terminal, so one kill in any of them pinned `killScanFloorFrom` to the
bottom of a veteran's history and the report scan re-read all of it on every
run. That is the scan half of #326.

## Provenance

A resolved window carries the source it came from, because the two sources
measure different things — a generated window is a union across regions, a
curated one is a sourced release date:

- `raiderio-raiding-static-data` — 25 raids, from the generated snapshot,
  optionally widened by a reviewed Blizzard announcement.
- `blizzard-release-dates` — the four pre-Legion raids, curated in full.

`resolveContentWindow` ranks the two differently, and the provenance is what
decides which rule applies. A **generated** window replaces a **pre-Legion**
curated one outright, so extending Raider.IO's coverage backwards needs nobody
to remember to delete an entry. A **reviewed** window is merged with the
generated one instead, taking the widest span, because a review only ever moves
a boundary outwards. Letting the generated value win there would narrow live
tiers — today it would cut 27 days off Sporefall's opening, 17 off The Venomous
Abyss's, and 15 days off Manaforge Omega's close — and a narrowed window
withholds real progression kills.

## Guards

`packages/domain/src/raid-catalogue.test.ts` fails when any catalogued raid has
no resolved window at all, so a new tier breaks the build rather than silently
discarding kills or stranding a veteran's scan floor. Further tests pin the
provenance split at 25/4, reject a curated window for any raid the generated
snapshot already serves, and reject any resolved window whose start is not
before its end. The boundary policy above is pinned by tests over the real
generated data.
