# Official raid artwork design

## Purpose

Make historic Mythic evidence easier to scan by showing official Blizzard art
for raid sections and their bosses, without relying on third-party image hosts.

## Data source

The generated raid catalogue remains the source of stable raid and encounter
metadata. Its generator will enrich every entry from Blizzard static game data:

- `media/journal-instance/{id}` supplies an optional raid tile.
- `journal-encounter/{id}` supplies encounter creatures.
- The creature whose name exactly matches the encounter name is the primary
  creature. Its `media/creature-display/{id}` `zoom` asset supplies an optional
  boss image.

Missing data, a non-matching creature, or an asset without `zoom` is normal.
The generated entry then omits that image rather than guessing or substituting
third-party art.

## Data flow

The generated catalogue stores optional `imageUrl` values for raids and
encounters. The domain catalogue preserves those fields when it maps Warcraft
Logs evidence to Blizzard Journal metadata. The applicant-dossier contract
returns the optional image URLs with its existing raid and boss data.

## Presentation

The historic Mythic evidence section shows a restrained raid tile beside the
raid heading and a square boss render beside each boss name. Images use clear
alt text naming their raid or boss. When a URL is absent or the image fails to
load, the evidence remains fully usable as text and its layout does not leave a
blank reserved image slot.

## Verification

Tests cover primary-creature selection, missing-media fallback, generated
catalogue parsing, dossier propagation, and rendered image alt text. The full
unit suite, lint, typecheck, format check, and a live Railway deployment are
run before handoff.
