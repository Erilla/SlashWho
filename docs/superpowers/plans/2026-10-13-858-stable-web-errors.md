# Stable web error diagnostics (#858) implementation plan

Status: approved at `177a574c` in review `5506778671`; implementation verified after merging PR #908 (`d6597a80`) and #907 (`cf394e6d`); Manager implementation review and deployed acceptance remain pending.

**Goal:** Web request and escaped-process failures expose readable names and safe codes in the production build, without recording messages or identity data.

**Architecture:** Export the application's shared `errorFields` helper and use it for all three web failure records. Prefer explicit non-generic names and set literal names on custom errors; retain server minification. Replace shape-only message acceptance with an explicit registry of code-authored literals.

**Tech stack:** TypeScript, Vitest, Next.js, Pino; all commands use `corepack pnpm`.

**Spec:** <https://github.com/Erilla/SlashWho/issues/858>, including all comments read on 13 October 2026.

## Isolation and dependencies

Branch: `fix/858-stable-web-errors`, following the repository branch convention.
Fetched base: `bd042af9886dcc1dad5e71a488551021e248be3d` (#905).
The coordinator verified the clean worktree before authorising this plan.

Manager confirmed registry membership, SQLSTATE class validation from `.code`
only, omission of `unauthorized`, and first-caught-cause precedence. Additional
conditions are an inventory test preserving worker codes and a literal-name
guard for all Error subclasses in the four packages. The implementation tests
cover every inventoried code independently of the production registry, and the
AST guard also covers non-exported subclasses such as `RankingLookupFailure`.

PR #908 touches `logger.ts`, `dossier-gateways.ts`, and Raider.IO errors and introduces `GuildNotFound`. Read its approved plan and changes before implementation, wait for its merge, fetch and merge `origin/main` into this issue's worktree, and re-check this plan against that tree. Never implement in the shared checkout. Later logging issues remain queued.

PR #908 does not change `error-fields.ts`: its fixture registry is separate. Preserve its exact endpoint/status/guild-message policy, settled-pair semantics, closed `RankingsFailureCode` counters, and uncounted caller aborts.

## Design decisions for review

1. Prefer `error.name` when it is nonempty and not `Error`, then fall back to constructor name. Keep identifier sanitisation and the existing 64-character bound. Both the application helper and web `errorName` must agree; make the latter delegate to the shared helper to avoid drift.
2. Add literal names to `RankingLookupFailure`, PR #908's `GuildNotFound`, and any remaining custom database errors without an explicit name. Existing `AuthenticationError` and queue timeout names stay intact. Upstream clients currently use `createUpstreamError`, not bespoke classes: set a stable `UpstreamError` name there. Its provider/kind distinction is represented by the closed code, not a generated class name.
3. A regex is not a closed set: `new Error("private_character_realm")` currently leaks that string as a code. Use a module-private explicit registry for application/database/upstream authored codes. Audit current literal throws and existing diagnostics tests to retain legitimate codes; include `rankings_unavailable`, `trusted_client_ip_unavailable`, and the known provider/kind combinations. Unknown snake_case messages and unknown `.code` strings become null. For SQLSTATE, accept only a five-character uppercase alphanumeric `.code` matching recognised PostgreSQL class prefixes, with no message fallback for numeric strings. This admits real driver SQLSTATEs, including letter-bearing codes, without treating arbitrary numeric messages as diagnostics. The Manager confirmed this SQLSTATE policy in review `5506778671`.
4. Keep the existing pattern restriction for registry literals; a code may be emitted only if both shape and membership checks pass. `unauthorized` stays without a code under the issue's snake_case requirement; its stable `AuthenticationError` name still identifies it.
5. HTTP stores the first caught `ErrorFields` pair and spreads it onto `http_request`; response counting failure must not overwrite the original cause. Process handlers spread the same pair. Add `errorCode` to the web allowlist. No message, URL, body, cause payload, optional stage, container configuration or cache-policy change.

## Test-first tasks (execute in this chat)

- [x] After dependency merge and plan approval, install with `corepack pnpm install --frozen-lockfile` and copy `.env.example` to `.env` inside this worktree.
- [x] Add `packages/application/src/error-fields.test.ts`: renamed constructor with literal name returns the literal and registered `rankings_unavailable`; generic Error still falls back; non-errors retain bounded type names; unsafe names remain sanitised. Assert arbitrary snake_case and numeric messages, URLs and payloads yield null codes; a known `.code` wins over a different registered message; unknown `.code` falls back only to a registered message; driver `23505`, `23514` and `40P01` are admitted from `.code`, invalid/unknown classes and free text are rejected. Run `corepack pnpm test:unit -- packages/application/src/error-fields.test.ts` and observe the relevant failures.
- [x] Implement the registry and stable-name selection in `error-fields.ts`; export `errorFields` and `ErrorFields` from `packages/application/src/index.ts`. Re-run the focused suite and existing evidence-job/retry-policy suites to identify intentional compatibility changes before committing `fix(application): expose safe stable error diagnostics`.
- [x] Add upstream factory and gateway regressions that rename constructor functions and prove literal names survive. Test actual factory provider/kind messages against the registry; arbitrary provider text must not become a code. Add literal names without altering classification, timeouts or cache behaviour; test existing gateway and upstream suites before committing `fix(errors): retain explicit names through minification`.
- [x] Extend `apps/web/src/server/http.test.ts`, `process-errors.test.ts` and `logger.test.ts`: action failure and response-counting failure each produce both fields, first cause wins, escaped exception/rejection and non-error rejection are covered, serialized records drop URL/body/message, and unknown snake_case codes remain absent/null. Assert dossier/error responses still use `Cache-Control: no-store`. Include a renamed-constructor error with stable name and registered code. Observe these tests fail before wiring `http.ts`, `process-errors.ts`, `error-name.ts`, and the allowlist. Re-run focused tests and commit `fix(web): log stable failure names and bounded codes`.
- [x] Run full gate with Docker available: `corepack pnpm format:check`, `lint`, `typecheck`, `test:unit`, `test:integration`, `build`, `test:e2e`. Read output; skipped suites do not pass. Self-review against `origin/main`, fix confirmed findings, fetch and merge current `origin/main`, then repeat the full gate. Never merge the PR or enable auto-merge.
- [ ] Convert this draft to an implementation PR only after those gates and review; update its body with actual checks and risk, retain `Refs #858` while deployment acceptance remains, and report the link to the coordinator.

## Review focus

Renamed constructors must preserve explicit names. Arbitrary snake_case text must not pass as a closed code. SQLSTATEs must be accepted only from driver codes. Response-counting errors must preserve the first failure and no-store. PR #908's no-match and cancellation semantics must remain unchanged. Each case is covered in the task tests above.

## Deployment acceptance

After Manager merge and test deployment, coordinate a safe known error request or wait for an existing failure. Record deployment SHA, UTC sample window, event/status, readable `errorName`, applicable `errorCode`, and no-store response evidence on #858. Inspect only approved structured fields; do not retain sensitive raw payloads. A credential-dependent operation or disruptive failure injection requires a concrete coordinator hand-off first. Local tests and builds are not deployment evidence; leave that acceptance item pending until measured.

## Alternatives and scope

Disabling minification would affect bundle size and container/runtime overlap with #902/PR #904; explicit names avoid that change. Keeping regex-only extraction cannot satisfy closed-set diagnostics. A new general error hierarchy or dossier stage field is unnecessary for #858. Registry maintenance is the principal risk: unknown new authored errors deliberately omit their code until explicitly admitted, while retaining their safe name.

## Execution ledger

- Merged main including #908 before product edits; no scope change required.
- Inventory: 202 authored codes from literal throws, configuration helper and
  database row-helper call sites, bounded provider/kind combinations and worker
  diagnostic/retry regressions. Each has an independent admission test.
- Red: 13 shared diagnostics regressions, two literal-name/factory regressions,
  and seven web record regressions failed for the missing behaviour.
- Green: 484 focused tests passed. Full unit suite: 208 files, 3,358 tests passed.
- Fixed a test-only TypeScript narrowing error in the AST name guard; typecheck
  and the guard suite passed afterwards.
- Ruling: source guard covers every direct Error subclass, including internal
  classes, beyond the requested exported-class guard; it protects future direct
  subclasses without maintaining a manual list of exports.
- Registry deliberately rejects unregistered snake_case strings and arbitrary
  numeric strings/messages. SQLSTATE comes only from driver code; existing
  socket errno codes remain unlogged. Retry classification is unchanged.
- First full gate passed: format, lint, typecheck; 3,358 unit tests in 208 files;
  481 Docker integration tests in 21 files; production build; 60 browser tests.
  Fresh whole-branch review and current-main integration gate remain next.
- Fresh read-only whole-branch review against `d6597a80`: no actionable findings. Deployment acceptance correctly remains outside local verification.
- Repeated integration gate on `d6597a80` failed two unchanged queue retry
  timestamp assertions: 83 ms and 79 ms below the existing 100 ms allowance.
  The first gate passed. Isolated queue suite passed all 17 tests afterwards.
  Fresh test PostgreSQL samples were within 1 ms of host time after warm-up;
  persistent skew is not established. Queue adapter, queue tests and PostgreSQL
  harness blobs exactly match current main. No tolerance or scheduler changes.
- Fetched/merged `cf394e6d` (#907) following coordinator instruction. Repeating
  the gate on this new tree; any load/clock explanation remains an inference
  until measurements establish it.
- Final current-main gate on `cf394e6d` passed: format, lint, typecheck;
  3,384 unit tests in 210 files; 481 Docker integration tests in 21 files;
  production build; 61 browser tests. No suites skipped.
- Concurrent clock measurement collected 2,434 samples: PostgreSQL timestamp
  minus host-before-query ranged from -4 ms to +55 ms, with zero negative
  50 ms outliers. Persistent skew is not established. Prior queue timing
  discrepancy remains unconfirmed and is disclosed in the PR body.
- Implementation PR hand-off uses `Refs #858`, retaining the issue for test
  deployment acceptance. No deployed measurements, merge or auto-merge claimed.

## Manager implementation review fixes

Review `5507279934` requested two fixes, read and verified against the source.

- `92a44bb4`: treat generic error names case-insensitively. The pg-protocol
  instance name is lowercase `error`; two new regressions failed first, then
  four variants (`error`, `ERROR`, `Error`, empty) preserve `DatabaseError`
  with `23505`. Shared diagnostics/web/worker focused suite passed 468 tests.
- `c1b81029`: non-test source AST guard scans packages, worker and web server
  for literal error creation/calls, row/environment helper code arguments,
  error class fields/types, code assignments and thrown object literals.
  It requires more than 150 distinct discovered codes, with no unlogged
  snake_case exceptions. Mutation regressions caught the missing scanner and
  two initially missed thrown-object forms before implementation. It detects
  unregistered injected codes without mutating repository source files.
  Focused diagnostics/name/inventory suites passed 253 tests; application
  typecheck passed. Full gate and fresh fix review are next.
- Manager accepts the earlier unchanged queue timing discrepancy as unrelated.
  Optional helper/layout, indirect-class and legacy PG16 class notes remain
  outside the required fixes; no scheduler or timing-tolerance changes.
- Fresh read-only fix review: no actionable findings in `215c7ca7..c1b81029`.
- Review-fix gate: format/lint/typecheck and 3,412 unit tests in 211 files passed.
  The default-concurrency integration run timed out in unchanged migration
  backfill and character-group overlapping-pass tests (479/481 passed).
  Both suites passed in isolation: 47 tests at `--maxWorkers=2`.
- Coordinator drained the other assigned integration lanes and authorised
  `corepack pnpm test:integration --maxWorkers=3`, matching documented CI
  concurrency, with all original tests/timeouts/assertions retained. It passed
  all 481 tests in 21 files (103.89 s). The held lanes were released immediately
  afterwards. Host contention remains an inference; no proven cause or
  shared-service restart is claimed. Build/browser verification follows.
- Review-fix production build and all 61 browser tests passed on unchanged
  `cf394e6d`. Coordinator reported #909 landing as `262b044f` while e2e was
  running; e2e completed before any merge. Those results belong to the old
  tree only. Fetch/integrate the newer main and verify the merged tree before
  pushing the fixes; use the authorised integration `--maxWorkers=3` command.
- Latest-main verification on `53ca5d3c` (including #909 at `262b044f`) passed
  format, lint, typecheck, 3,429 unit tests in 212 files, 482 Docker integration
  tests in 21 files at `--maxWorkers=3`, production build, and all 61 browser
  tests. The earlier full unit run on this tree had one unchanged collection
  monitor UI test time out at its existing five-second limit (3,428/3,429); the
  isolated unchanged UI suite passed 24/24. The sampled 99.4% host CPU is
  associated evidence only; the cause remains unproven. No assertion or timeout
  changed.
- While completing that gate, `origin/main` advanced to `9cadcd43` (#906 and
  #818). Clean merge `192898e0` preserved the #858 implementation and guard.
  Its source inventory detected #906's two newly authored queue codes,
  `invalid_evidence_job_id` and `invalid_evidence_priority`. The first full
  unit run on the combined tree therefore failed the inventory and its mutation
  fixtures (3,419/3,442 passed); adding both explicit registry entries and
  independent admission cases fixed the omission. The focused nine-file
  diagnostics/name/inventory suite then passed 343/343, and current-tree format
  and typecheck passed. #906's own merged-tree gate had already passed. No
  further full unit or integration run was started after this merge; final
  GitHub CI will validate the pushed combined tree.
