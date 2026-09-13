# Applicant Dossier Design

**Date:** 2026-09-11

**Status:** Approved design; awaiting user review before implementation planning

## Summary

SlashWho will become an unlisted, Railway-hosted applicant-research tool for
one guild. It accepts either a Raider.IO character URL or a Warcraft Logs
character URL, discovers all linked characters using the existing Raider.IO
and Blizzard fingerprint techniques, then assembles an on-demand **applicant
dossier**.

The dossier focuses on historic Mythic raiding evidence: every historic
Cutting Edge raid represented in the applicant's public evidence, and every
boss in those raids. For each first Mythic kill, it shows the participating
character, first-kill guild, kill date, historic world rank for that specific
kill, and a direct Warcraft Logs link when available.

The deployment has no sign-in. It is intentionally unlisted and contains no
public navigation or crawlable character pages, but it is not secret: anyone
who obtains the Railway URL can access it. Rate limits remain to protect
upstream services and credentials.

## Goals

- Accept a full Raider.IO or Warcraft Logs character URL.
- Resolve either input to the existing canonical character key:
  `region / realm-slug / normalized-name`.
- Reuse durable Raider.IO discovery and Blizzard achievement-fingerprint
  discovery to identify linked characters.
- Produce a current, non-persistent applicant dossier across the root and all
  linked characters.
- Show historic Cutting Edge raid evidence at boss granularity.
- For every first Mythic kill found, show its character, guild, date, historic
  world rank, and report/fight evidence link.
- Attribute relationships with the retained source label: Raider.IO-declared
  or fingerprint-derived.
- Make missing, private, unavailable, rate-limited, and schema-invalid source
  data explicit without treating it as a negative finding.

## Non-goals

- Authentication, user accounts, or guild membership verification.
- A public directory, public API, crawlable pages, or historic character
  snapshot UI.
- Saving dossiers, raid evidence, Warcraft Logs payloads, or applicant
  assessments in PostgreSQL.
- Treating an absent Warcraft Logs record as proof that the applicant did not
  kill a boss.
- Current guild ranking, character parse rankings, wipe analysis, or a full
  application workflow/questionnaire.

## Terms and evidence rules

The existing definitions of **fingerprint-derived link**, **reviewer surface**,
**applicant dossier**, and **source label** in `CONTEXT.md` apply.

**Historic world rank** means the world rank attached to the applicant's
first public logged Mythic kill for that specific boss. It is not the current
world rank of that guild or its current raid-tier progression rank.

**First Mythic kill** is the earliest valid public Warcraft Logs kill evidence
for a character/boss combination. If multiple linked characters participated
in the same evidence, the dossier presents one kill record with every
participating applicant character attributed to it. Evidence is never inferred
from a current guild roster.

**Cutting Edge raid** is a historic raid tier for which the gathered public
evidence establishes the applicant's Mythic progression through the tier's
final encounter. A dossier shows the actual boss evidence and identifies any
source limitation rather than manufacturing an achievement claim.

## Architecture

The durable discovery pipeline remains the source of truth for character
relationships:

```text
Raider.IO or Warcraft Logs URL
          |
          v
canonical character key
          |
          v
existing durable discovery run
(Raider.IO + Blizzard fingerprint)
          |
          v
linked-character snapshot + source labels
          |
          v
on-demand Warcraft Logs gathering
          |
          v
transient applicant dossier returned to browser
```

Character discovery continues to use PostgreSQL, `pg-boss`, the worker, and
the existing atomic snapshot semantics. A dossier is assembled only after a
current snapshot is readable. It is returned in the dossier HTTP response and
is not stored; reloading the dossier queries the current upstream evidence
again.

## Components

### `@slashwho/domain`

- Add validated parsing for supported Warcraft Logs character URLs.
- Define source-neutral dossier value types: character evidence, raid, boss,
  first-kill evidence, and source limitation.
- Define pure aggregation rules for grouping boss evidence into raid tiers,
  ordering first kills, and deduplicating a shared kill across linked
  characters.

It remains independent of GraphQL, OAuth, HTTP, and database representations.

### `@slashwho/warcraftlogs`

Introduce a package that owns:

- client-credential OAuth token acquisition and in-process token reuse;
- Warcraft Logs GraphQL request construction and pagination;
- defensive parsing and normalization of character, raid, encounter, report,
  fight, guild, timestamp, and historic-rank data;
- clear failure categories: not found, private/unavailable, rate limited,
  transient upstream failure, and schema drift.

The package exposes a small gateway capable of resolving a Warcraft Logs URL
and obtaining historic Mythic first-kill evidence for one canonical character.
It returns normalized values, never raw GraphQL responses.

### `@slashwho/application`

Add an `ApplicantDossierService` that:

1. accepts either supported URL and resolves it to a canonical key;
2. reuses or creates the current durable discovery run;
3. reads the completed linked-character snapshot and source labels;
4. requests Warcraft Logs evidence for every linked character;
5. aggregates, deduplicates, attributes, and orders evidence; and
6. returns the transient dossier plus source limitations.

The service does not write dossier material or evidence to repositories. It
does reuse existing character snapshots, run status, queue, and rate-limit
infrastructure.

### Web application

Replace the public-search homepage with a focused dossier search form. The
browser starts/reuses discovery, polls its existing job state, and requests a
dossier once a snapshot is ready.

The dossier page contains:

- applicant identity and direct Raider.IO/Warcraft Logs links;
- linked characters with their source labels;
- historic Cutting Edge raid sections;
- expandable boss evidence with first-kill character(s), guild, date, historic
  world rank, and report/fight link; and
- a concise, local limitation message for incomplete source data.

Remove public navigation and the public character-history experience from the
visible UI and deployment documentation. The durable historical snapshots may
remain an internal implementation detail while no route or public API presents
them as a public archive.

## HTTP and lifecycle

The web app exposes dossier-oriented routes rather than the public `/api/v1`
surface. One submission accepts either URL. Its response is either a reusable
discovery job or a ready canonical identity. When discovery is complete, a
dossier read produces the unsaved report.

No dossier job state or dossier payload is written to the database. A
Warcraft Logs failure after discovery succeeds returns a dossier containing
relationship information and source-limitation entries. This prevents one
unavailable character or private log from hiding all other evidence.

The dossier HTTP request is bounded by a configurable per-request character
and upstream-request cap. A cap is a visible limitation, not evidence of no
history. Transient upstream errors receive a safe error message and permit a
fresh browser retry; they never modify discovery snapshots.

## Configuration and deployment

Railway continues to run web, worker, and PostgreSQL services. Add the
Warcraft Logs OAuth client ID and secret to the web service only, because
dossier gathering is on demand. Never expose either secret to the browser,
logs, route responses, or error messages.

Keep request and search rate limits. They protect Raider.IO, Blizzard, and
Warcraft Logs regardless of the tool being unlisted. Document the Railway
service configuration as an internal guild tool, and remove the old public
website/privacy/removal and bot-API deployment claims.

## Testing strategy

### Unit and contract tests

- Raider.IO and Warcraft Logs URL parsing/canonicalization.
- Warcraft Logs OAuth, pagination, GraphQL normalization, and schema drift.
- First-kill ordering, historic-world-rank mapping, shared-kill
  deduplication, and per-character attribution.
- Cutting Edge raid grouping and final-boss completion rules.
- Partial-source states, request caps, and safe failure serialization.
- Dossier service orchestration with fresh, stale, active, and failed
  discovery states.

### Integration and browser tests

- Existing PostgreSQL discovery/snapshot tests remain unchanged.
- Dossier requests use recorded and sanitized Warcraft Logs fixtures.
- An end-to-end browser journey submits each URL form, waits for discovery,
  and renders a complete and partial dossier without exposing credentials or
  raw payloads.
- Responsive and accessible rendering covers the raid/boss hierarchy and
  keyboard operation of expandable evidence.

## Acceptance criteria

1. Either supported URL reaches the same canonical applicant identity.
2. The existing Raider.IO and Blizzard techniques discover and label linked
   characters before dossier evidence is gathered.
3. The dossier reports all historic Cutting Edge raids represented by public
   evidence and every boss in each raid.
4. Each available first Mythic kill shows guild, date, historic world rank,
   character attribution, and direct evidence link.
5. Shared evidence is shown once while crediting every applicant character
   present in it.
6. Unavailable, private, rate-limited, or capped evidence is visibly partial,
   never silently negative.
7. Dossier data and raw Warcraft Logs responses are never persisted.
8. The deployed interface contains no public-directory or crawlable-character
   affordance, while rate limits and secret handling remain enforced.
