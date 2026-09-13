# Background Applicant Evidence Design

**Status:** Approved for implementation

## Purpose

Applicant dossiers must show complete, public historic Mythic evidence for a
character without relying on a short-lived web request. A character with many
recent reports can otherwise exhaust the eight- or fifteen-second request
deadline before Warcraft Logs reaches current-tier raid reports.

## Decision

The worker owns a durable, normalized **character evidence cache**. It gathers
Warcraft Logs history for one canonical character in a queued job and persists
only normalized Mythic-kill facts and a safe completion state. It never stores
OAuth credentials or raw Warcraft Logs responses. The web dossier reads cached
evidence and returns promptly.

The discovery snapshot remains the authority for linked characters. Evidence
is cached per character, rather than per applicant dossier, so a character
that appears in multiple applicant searches is not scanned repeatedly.

## Data model

`character_evidence_runs` records one queued/running/retrying/complete/partial
scan per character. A partial run carries a safe limitation code. Its latest
completed result is selected independently of a newer active refresh.

`character_mythic_kills` stores normalized data already exposed by the
Warcraft Logs gateway: raid and boss identifiers/names, kill time, report and
fight links, guild identity, and participating character key. It has a unique
source-fight key. Replacing a completed character result is transactional so a
reader never observes half a scan.

The cache can be refreshed once it is older than the configured evidence
freshness period. Concurrent searches use one active queue job per character.

## Worker and web lifecycle

1. Discovery creates or reuses the existing linked-character snapshot.
2. The web dossier read requests evidence jobs for snapshot characters whose
   cache is missing or stale, then returns any completed cache rows immediately.
3. The worker fetches all Warcraft Logs report pages up to a worker-owned cap,
   persists the complete result atomically, or persists the collected result
   with a limitation when the provider is unavailable/rate-limited/capped.
4. The browser polls evidence status alongside discovery and refreshes the
   dossier after all requested character jobs settle.

The worker receives the Warcraft Logs credentials; the web retains them only
until this change is deployed, then no longer makes direct WCL evidence calls.
Neither service returns or logs credentials or raw upstream payloads.

## Evidence coalescing

Different Warcraft Logs reports can record the same guild kill. Dossier
aggregation treats rows as one kill when boss identity, normalized guild name
and realm match and kill timestamps are within two minutes. The grouped entry
uses the earliest timestamp, unions applicant-character attribution, keeps one
deterministic report link, and calculates historic rank from that grouped kill.
Distinct guild kills or kills outside that window remain separate.

## Presentation

Every raid and boss media slot always renders. Official Blizzard art is used
when available; otherwise a local, accessible fallback emblem occupies the
same slot. Each raid is a self-contained dark panel with a full background,
border, padding, and separated boss evidence.

## Error handling

Cached evidence is honest: a partial scan is displayed with its existing
source limitation, never as a negative claim. A failed refresh does not erase
the last completed cache. Jobs obey queue retry policy and a worker-owned WCL
request cap. The UI distinguishes gathering from settled partial evidence.

## Acceptance criteria

- Rinn-like high-report characters do not lose current-tier evidence because a
  browser request times out.
- Cached dossier reads make no direct WCL history request.
- Duplicate reports of one guild boss kill render as one row with merged
  applicant-character attribution.
- Missing official art renders a local fallback for raids, bosses, and Cutting
  Edge achievements.
- Raid tiers are visually distinct full-background blocks.
- Only normalized evidence and safe state persist; no raw WCL response or
  credential is stored or logged.
