# Issue #764: Warcraft Logs recent-report history ceiling

## Goal and evidence

Skyaug, Skyshamyx and Knuxxm runs stopped with `unavailable` and saved page 6. Replaying the production query on 2026-10-01 returned HTTP 200 plus `The page argument must be a value between 1 and 5.` for all three. The scanner follows `has_more_pages` without respecting that ceiling, and the transport turns the validation error into a transient limitation.

## Proposed fix

1. Add the upstream recentReports maximum page (5) beside the existing page-size constant. Keep page size and GraphQL selection unchanged: changing page size invalidates existing page offsets and changes query complexity.
2. Bound history reads and resume probes to supported pages. Restart any stored cursor beyond the ceiling at page 1, preserving stored evidence through partial publication. At the ceiling, report a new `history_limit` limitation if `has_more_pages` is true; naturally exhausted history or a reached scan floor remains complete. A smaller local request cap still reports `request_cap` and supports ordinary resume.
3. At the upstream ceiling, emit no out-of-range resume cursor or boundary. Ensure publication clears the old invalid cursor. No data migration or production writes: existing partial runs reach the corrected path on their next scheduled/ordinary collection.
4. Carry `history_limit` through provider types, contracts, dossier explanation and phase labels. The dossier says Warcraft Logs limits the accessible recent-report history, evidence is partial, and older kills/wipes may exist. Waiting alone cannot extend that history, so `history_limit` has no automatic retry; simultaneous retryable parse or other source failures keep their existing retry decisions. Do not claim complete history or mark terminal raids from this partial result.
5. Regression tests cover: five pages still claiming more; natural exhaustion on/before page 5; a smaller local request cap; valid resume through page 5; existing page-6 and greater cursors; retained kills/wipes/parses; no invalid emitted cursor; non-retryable history limit alongside retryable parse failures; public schema and wording.

## Validation and delivery

Write regression tests first and observe the failures. Run the full gate: format:check, lint, typecheck, test:unit, test:integration, build, test:e2e with Docker running. Review against origin/main, merge any newer trunk commits and repeat required verification. Convert this draft to the implementation PR, monitor CI and all PR comments, address findings and resolve fixed review threads. Never enable auto-merge or merge the PR.

## Review requested

Please confirm the explicit partial, non-retryable `history_limit` semantics and restarting unsupported saved cursors while preserving evidence. This draft is the plan hand-off required by issue-pickup for evidence collection changes; implementation follows manager approval.