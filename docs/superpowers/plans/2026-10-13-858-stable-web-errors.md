# Stable web error diagnostics (#858) implementation plan

Status: proposed; Manager approval and PR #908 merge required before implementation.

**Goal:** Web request and escaped-process failures expose readable names and safe codes in the production build, without recording messages or identity data.

**Architecture:** Export the application's shared `errorFields` helper and use it for all three web failure records. Prefer explicit non-generic names and set literal names on custom errors; retain server minification. Replace shape-only message acceptance with an explicit registry of code-authored literals.

**Tech stack:** TypeScript, Vitest, Next.js, Pino; all commands use `corepack pnpm`.

**Spec:** <https://github.com/Erilla/SlashWho/issues/858>, including all comments read on 13 October 2026.

## Isolation and dependencies

Worktree: `G:/repos/SlashWho/.claude/worktrees/fix-858-stable-web-errors`.
Branch: `fix/858-stable-web-errors`, following the repository branch convention.
Fetched base: `bd042af9886dcc1dad5e71a488551021e248be3d` (#905).
The coordinator verified the clean worktree before authorising this plan.

PR #908 touches `logger.ts`, `dossier-gateways.ts`, and Raider.IO errors and introduces `GuildNotFound`. Read its approved plan and changes before implementation, wait for its merge, fetch and merge `origin/main` into this issue's worktree, and re-check this plan against that tree. Never implement in the shared checkout. Later logging issues remain queued.

PR #908 does not change `error-fields.ts`: its fixture registry is separate. Preserve its exact endpoint/status/guild-message policy, settled-pair semantics, closed `RankingsFailureCode` counters, and uncounted caller aborts.

## Design decisions for review

1. Prefer `error.name` when it is nonempty and not `Error`, then fall back to constructor name. Keep identifier sanitisation and the existing 64-character bound. Both the application helper and web `errorName` must agree; make the latter delegate to the shared helper to avoid drift.
2. Add literal names to `RankingLookupFailure`, PR #908's `GuildNotFound`, and any remaining custom database errors without an explicit name. Existing `AuthenticationError` and queue timeout names stay intact. Upstream clients currently use `createUpstreamError`, not bespoke classes: set a stable `UpstreamError` name there. Its provider/kind distinction is represented by the closed code, not a generated class name.
3. A regex is not a closed set: `new Error("private_character_realm")` currently leaks that string as a code. Use a module-private explicit registry for application/database/upstream authored codes. Audit current literal throws and existing diagnostics tests to retain legitimate codes; include `rankings_unavailable`, `trusted_client_ip_unavailable`, and the known provider/kind combinations. Unknown snake_case messages and unknown `.code` strings become null. For SQLSTATE, accept only a five-character uppercase alphanumeric `.code` matching recognised PostgreSQL class prefixes, with no message fallback for numeric strings. This admits real driver SQLSTATEs, including letter-bearing codes, without treating arbitrary numeric messages as diagnostics. The Manager should confirm this SQLSTATE policy or require a fully enumerated supported-code list.
4. Keep the existing pattern restriction for registry literals; a code may be emitted only if both shape and membership checks pass. `unauthorized` stays without a code under the issue's snake_case requirement; its stable `AuthenticationError` name still identifies it.
5. HTTP stores the first caught `ErrorFields` pair and spreads it onto `http_request`; response counting failure must not overwrite the original cause. Process handlers spread the same pair. Add `errorCode` to the web allowlist. No message, URL, body, cause payload, optional stage, container configuration or cache-policy change.

## Test-first tasks (execute in this chat)

- [ ] After dependency merge and plan approval, install with `corepack pnpm install --frozen-lockfile` and copy `.env.example` to `.env` inside this worktree.
- [ ] Add `packages/application/src/error-fields.test.ts`: renamed constructor with literal name returns the literal and registered `rankings_unavailable`; generic Error still falls back; non-errors retain bounded type names; unsafe names remain sanitised. Assert arbitrary snake_case and numeric messages, URLs and payloads yield null codes; a known `.code` wins over a different registered message; unknown `.code` falls back only to a registered message; driver `23505`, `23514` and `40P01` are admitted from `.code`, invalid/unknown classes and free text are rejected. Run `corepack pnpm test:unit -- packages/application/src/error-fields.test.ts` and observe the relevant failures.
- [ ] Implement the registry and stable-name selection in `error-fields.ts`; export `errorFields` and `ErrorFields` from `packages/application/src/index.ts`. Re-run the focused suite and existing evidence-job/retry-policy suites to identify intentional compatibility changes before committing `fix(application): expose safe stable error diagnostics`.
- [ ] Add upstream factory and gateway regressions that rename constructor functions and prove literal names survive. Test actual factory provider/kind messages against the registry; arbitrary provider text must not become a code. Add literal names without altering classification, timeouts or cache behaviour; test existing gateway and upstream suites before committing `fix(errors): retain explicit names through minification`.
- [ ] Extend `apps/web/src/server/http.test.ts`, `process-errors.test.ts` and `logger.test.ts`: action failure and response-counting failure each produce both fields, first cause wins, escaped exception/rejection and non-error rejection are covered, serialized records drop URL/body/message, and unknown snake_case codes remain absent/null. Assert dossier/error responses still use `Cache-Control: no-store`. Include a renamed-constructor error with stable name and registered code. Observe these tests fail before wiring `http.ts`, `process-errors.ts`, `error-name.ts`, and the allowlist. Re-run focused tests and commit `fix(web): log stable failure names and bounded codes`.
- [ ] Run full gate with Docker available: `corepack pnpm format:check`, `lint`, `typecheck`, `test:unit`, `test:integration`, `build`, `test:e2e`. Read output; skipped suites do not pass. Self-review against `origin/main`, fix confirmed findings, fetch and merge current `origin/main`, then repeat the full gate. Never merge the PR or enable auto-merge.
- [ ] Convert this draft to an implementation PR only after those gates and review; update its body with actual checks and risk, retain `Refs #858` while deployment acceptance remains, and report the link to the coordinator.

## Review focus

Renamed constructors must preserve explicit names. Arbitrary snake_case text must not pass as a closed code. SQLSTATEs must be accepted only from driver codes. Response-counting errors must preserve the first failure and no-store. PR #908's no-match and cancellation semantics must remain unchanged. Each case is covered in the task tests above.

## Deployment acceptance

After Manager merge and test deployment, coordinate a safe known error request or wait for an existing failure. Record deployment SHA, UTC sample window, event/status, readable `errorName`, applicable `errorCode`, and no-store response evidence on #858. Inspect only approved structured fields; do not retain sensitive raw payloads. A credential-dependent operation or disruptive failure injection requires a concrete coordinator hand-off first. Local tests and builds are not deployment evidence; leave that acceptance item pending until measured.

## Alternatives and scope

Disabling minification would affect bundle size and container/runtime overlap with #902/PR #904; explicit names avoid that change. Keeping regex-only extraction cannot satisfy closed-set diagnostics. A new general error hierarchy or dossier stage field is unnecessary for #858. Registry maintenance is the principal risk: unknown new authored errors deliberately omit their code until explicitly admitted, while retaining their safe name.
