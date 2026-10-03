# Issue #782: resolve historic Raider.IO roster identities

## Evidence and intended outcome

A character's tier-28 first-kill list contains a Mythic final-boss kill and a logged encounter with a visible 20-player roster. The current profile ID differs from its historic roster ID, so `collectRaiderIoFirstKills` discards the kill. The dossier consequently loses both kill and roster, independently of the WCL five-page history ceiling. Public examples and regression fixtures must be anonymised.

On 2026-10-03, requesting the roster member's historic `name-<id>` profile on the historic realm returned the current profile's ID and current realm. This provides upstream identity resolution, rather than a name-based identity inference. The logged encounter's historical roster itself remains unchanged.

## Proposed design

1. Keep direct roster-ID presence as the cheapest proof. On a mismatch, resolve eligible historic roster profile entries through Raider.IO's character-detail endpoint and require the resolved profile ID to equal the subject's current ID. A name, numeric suffix, class, achievement date or kill-list association alone must never establish presence. Do not create aliases or account connections from these reads.
2. Add a narrow gateway operation for historical roster profile resolution. Validate region, realm and the upstream tombstone name: a numeric suffix must equal that roster member's recorded ID. Encode every path segment. Parse only the current resolved character ID and other minimal validation fields; never persist a raw response. Ordinary character-key validation stays unchanged. A suffix is a locator, not proof. Ordinary unsuffixed roster names must not become an identity fallback without a separate upstream proof, because a name can change owner.
3. Resolve once per unique historical roster profile in a collection run and reuse answers across its encounters. Use an explicit maximum of 50 physical identity resolutions per run and concurrency at most four. Prioritise candidates with the subject's class; obtain that class from the existing current-character read. Class filters candidates only, never proves identity. Stop launching requests on rate limiting or transient failure. Deferred/unresolved candidates must preserve evidence and drive the existing Raider.IO retry machinery; a definitive different resolved ID remains a mismatch. Preserve the existing independent logged-encounter allowance; count these new physical requests in Raider.IO observability and request bounds. Manager review must confirm these bounds and whether a stricter candidate filter is required.
4. Set `presenceChecked` only after a direct or upstream-resolved ID match. Reuse that durable fact on later roster privacy refreshes as today. Preserve existing hidden-roster handling, unsuccessful/non-Mythic and raid/boss mismatch rejection, and partial publication guarantees. Leave the WCL scan ceiling, parse attribution and report URLs unchanged. Keep public roster membership historical; do not highlight an old-name member as a current dossier character through name heuristics.
5. Bump the settled Raider.IO tier-read version so the next ordinary eligible collection asks previously dropped historical tiers again. Verify that fresh/light scheduling does not postpone the correction behind an earlier successful-but-empty tier read; use the existing evidence collection version mechanism if required, with its exact effects documented before implementation. Do not issue an ad hoc production update or claim that all WCL history is complete. A normal collection should recover the Raider.IO kill and roster even when no WCL report is recovered.
6. Add sanitised regressions for direct-ID presence, historical profile resolving to the current ID, resolving to another ID, malformed suffix/unsupported keys, deduplication and request bounds, transient/rate-limit/deferred resolutions, hidden-to-visible roster rechecks, stored presence, publication/readback and public dossier roster rendering. Assertions must prove that the exact-ID mismatch remains rejected unless an upstream resolution establishes identity. Include the no-WCL-report case and tier-mark recovery.

## Review and delivery

This changes the original #732 visible-roster ID-matching rule by adding an upstream-proven identity resolution, and touches budgets and evidence publication. Request Manager approval of the identity proof, new request bounds, retry semantics and rollout before coding, per `.agents/skills/issue-pickup/SKILL.md` step 5.

After approval, implement test-first, update the relevant domain design text, run the entire gate (format, lint, typecheck, unit, Docker-backed integration, build and e2e), review against origin/main, merge any newer main and repeat required verification. Convert this draft into the implementation PR, monitor CI and comments, and address findings. Never enable auto-merge or merge the PR.

## Decisions requested

- Accept upstream resolution of a historical tombstone profile to the current character ID as presence proof; reject names alone.
- Approve a separate cap of 50 identity-resolution reads per run with concurrency four, deduplicated across encounters and included in measurements.
- Approve ordinary versioned recollection of previously dropped historical tiers without deleting stored evidence.
