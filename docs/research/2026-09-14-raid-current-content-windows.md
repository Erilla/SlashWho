# Raid current-content windows

The dossier accepts Mythic boss evidence only when its timestamp is inside the
reviewed current-content window for its Journal raid. The source catalogue does
not include season timing, so the domain catalogue maintains these reviewed
windows separately.

## Boundary policy

Windows are half-open UTC intervals: a kill at `startsAt` is included and a
kill at `endsAt` is excluded. Blizzard publishes unlock _dates_, not one global
instant valid for every region, so each published date is stored as `00:00:00Z`.
This makes the boundary reproducible. A raid without a reviewed window is
unknown: its evidence is withheld and reported as
`current_content_window_unknown`; it is never described as a missing kill.
Evidence outside a reviewed window is likewise withheld and reported as
`current_content_evidence_withheld`.

## Reviewed windows

| Journal raid                     | Window                                           |
| -------------------------------- | ------------------------------------------------ |
| Nerub-ar Palace (`1273`)         | `2024-09-17T00:00:00Z` to `2025-03-04T00:00:00Z` |
| Liberation of Undermine (`1296`) | `2025-03-04T00:00:00Z` to `2025-08-12T00:00:00Z` |
| Manaforge Omega (`1302`)         | `2025-08-12T00:00:00Z` to `2026-03-17T00:00:00Z` |
| The Voidspire (`1307`)           | `2026-03-24T00:00:00Z` onward                    |
| March on Quel'Danas (`1308`)     | `2026-03-31T00:00:00Z` onward                    |
| The Dreamrift (`1314`)           | `2026-03-24T00:00:00Z` onward                    |
| Sporefall (`1305`)               | `2026-05-20T00:00:00Z` onward                    |
| The Tidebound Grotto (`1317`)    | `2026-08-19T00:00:00Z` onward                    |

The War Within dates come from Blizzard's season and raid announcements:
[Season 1](https://worldofwarcraft.blizzard.com/en-us/news/24137817/the-war-within-season-1-now-live),
[Season 2](https://worldofwarcraft.blizzard.com/en-us/news/24178759), and
[Season 3](https://worldofwarcraft.blizzard.com/en-gb/news/24215413).
Midnight dates come from Blizzard's [Season 1 schedule](https://worldofwarcraft.blizzard.com/en-gb/news/24266321/midnight-season-1-mythic-now-available),
[March on Quel'Danas availability](https://worldofwarcraft.blizzard.com/en-gb/news/24243864),
and [Sporefall announcement](https://worldofwarcraft.blizzard.com/en-us/news/24272110).

When a future season supersedes an open window, add its reviewed end timestamp
in `packages/domain/src/raid-catalogue.ts` before admitting its evidence.
