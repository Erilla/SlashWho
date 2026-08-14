# SeriouslyCasualBotV2 Applicant Intel comparison

**Question.** What Applicant Intel-relevant behaviours, data inputs, and tests
exist in SeriouslyCasualBotV2 but are absent or materially different in
SlashWho?

**Scope.** This source comparison excludes deployment, credentials, Discord
configuration, and monitoring. Discord is mentioned only where an upstream
application workflow supplies an Applicant Intel input or reviewer output.

## Revisions and method

- **Upstream:** `Erilla/SeriouslyCasualBotV2` default branch `main`, checked at
  [`aed4021478030233b39da099d57ac68642e835ed`](https://github.com/Erilla/SeriouslyCasualBotV2/tree/aed4021478030233b39da099d57ac68642e835ed)
  (the branch HEAD reported by `git ls-remote` on 2026-08-15).
- **Local baseline:** SlashWho
  [`6108d2f7923f5200ff4c4c890f82203de3859376`](https://github.com/Erilla/SlashWho/tree/6108d2f7923f5200ff4c4c890f82203de3859376),
  checked locally on 2026-08-15.
- An “absent” statement means no corresponding behaviour was found in
  SlashWho’s public contract, web application, domain/application packages, or
  their tests at that revision. It is not a claim about future feasibility.

## Current upstream behaviour

1. **Application-scoped intelligence.** An applicant starts and submits an
   application; officers can refresh linked characters. The command reference
   documents `/apply` and application management, and an integration suite
   verifies application persistence and lifecycle.
   [Interaction handler](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/interactions/application.ts),
   [commands](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/docs/commands.md),
   [integration tests](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/tests/integration/applications-flow.test.ts).

2. **Multi-character intake, enrichment, and provenance.** A job begins with
   all applicant-declared characters, harvests character links from the active
   application conversation, then runs alt discovery. Found-character output
   distinguishes declared/application characters from undeclared findings and
   shows class, guild, confidence and, where available, Discord corroboration.
   [Job runner](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/functions/applications/intel/runJob.ts),
   [link harvesting](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/functions/applications/harvestLinkedCharacters.ts),
   [renderer](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/functions/applications/intel/render.ts),
   [alt tests](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/tests/unit/discoverAlts.test.ts).

3. **Mythic-raid evidence.** The gatherer pools applicant characters with
   selected alts and uses Warcraft Logs plus Raider.IO kill dates. Rendered
   results show per-tier boss depth, kills or best wipe percentage, attributed
   character, report links, and first-kill dates where available.
   [Gatherer](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/functions/applications/mythic-logs/gatherMythicLogs.ts),
   [Warcraft Logs service](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/services/warcraftlogs.ts),
   [rendering](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/functions/applications/intel/render.ts),
   [gatherer tests](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/tests/unit/gatherMythicLogs.test.ts).

4. **Guild-history evidence.** From the same Raider.IO Mythic-kill data, the
   upstream aggregator groups guild/raid stints and may mark Cutting Edge when
   evidence supports it. Its output includes guild/realm, dates, kill count,
   raid, and participating characters.
   [Aggregation](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/functions/applications/mythic-logs/gatherMythicLogs.ts),
   [renderer](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/functions/applications/intel/render.ts),
   [rendering tests](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/tests/unit/intelRender.test.ts).

5. **Resilient, per-application presentation.** It persists status/phases,
   pauses on rate limits, resumes, supports top-ups when new links arrive, and
   publishes found characters, guild history, and logs independently. Tests
   cover job storage/execution, rate limiting, resumption, pagination, and
   refresh guards.
   [Job runner](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/functions/applications/intel/runJob.ts),
   [job store](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/functions/applications/intel/jobStore.ts),
   [run tests](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/tests/unit/intelRunJob.test.ts),
   [resume tests](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/tests/unit/intelResumeJobs.test.ts),
   [pagination](https://github.com/Erilla/SeriouslyCasualBotV2/blob/aed4021478030233b39da099d57ac68642e835ed/src/interactions/intelPagination.ts).

## SlashWho at the local baseline

SlashWho is a character-discovery product. A caller submits one Raider.IO URL
to `SearchService` and receives a current character snapshot or an async
discovery-run status. Its public contract is character identity, class, level,
Raider.IO URL, snapshot metadata, and active-job status—not application
identity, applicant answers, raid-log evidence, guild-history evidence, or
reviewer findings.
[Search service](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/packages/application/src/search-service.ts),
[public contract](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/packages/contracts/src/character.ts),
[API tests](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/apps/web/src/app/api/v1/api-contract.test.ts).

There is material overlap with upstream’s found-character functionality:
SlashWho collects Raider.IO owner-claimed characters, pivots to declared mains
and privacy-safe guesses, and performs a Blizzard achievement-fingerprint
sweep. It persists an immutable character-membership snapshot. But the output
is intentionally basic and does not expose provenance or confidence; it is
initiated by public character search rather than an application review.
[Discovery](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/packages/domain/src/discovery.ts),
[fingerprint discovery](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/packages/domain/src/fingerprint-discovery.ts),
[fingerprint tests](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/packages/domain/src/fingerprint-discovery.test.ts),
[serializer tests](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/packages/application/src/serializers.test.ts),
[discovery handler](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/packages/application/src/discovery-job-handler.ts).

No local source or test hit references `WarcraftLogs`/`warcraftlogs`, an
application entity/questionnaire, or an applicant-intel job/output. Relevant
local coverage instead validates Raider.IO normalisation/client behaviour,
fingerprint discovery, search orchestration, and API snapshots.
[Raider.IO tests](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/packages/raiderio/src/client.test.ts),
[search tests](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/packages/application/src/search-service.test.ts),
[handler tests](https://github.com/Erilla/SlashWho/blob/6108d2f7923f5200ff4c4c890f82203de3859376/packages/application/src/discovery-job-handler.test.ts).

## Candidate-gap inventory (not prioritised)

| Candidate capability | Upstream evidence | SlashWho comparison |
| --- | --- | --- |
| Application-scoped intake and review identity | Application interaction and lifecycle tests | No application entity or contract; search is root-character scoped. |
| Multi-character applicant input and reviewer provenance | Link harvesting and source-labelled output | Related-character discovery exists, but not applicant/conversation provenance, confidence or Discord verdicts. |
| Multi-guild/former-guild fingerprint seeds | Upstream Intel alt pipeline | Local sweep starts from the root guild; no Applicant Intel BFS context. |
| Guild-history/CE evidence | Kill-history aggregation and rendering | No kill-history input or guild-history output. |
| Mythic progression, wipes and report links | Warcraft Logs gatherer/service/tests | No Warcraft Logs client, model, output contract, or tests. |
| Per-application phase outputs, refresh/top-up, resume and pagination | Job store/runner/resume/pagination tests | Generic durable discovery runs exist, but no Applicant Intel phases/output lifecycle. |
| Applicant-Intel test surface | Upstream unit/integration tests above | Current tests cover discovery/search, not Applicant Intel. |

This inventory does not recommend an implementation order or assert that all
upstream behaviour belongs in SlashWho. It records the current functional delta
for issue #44.
