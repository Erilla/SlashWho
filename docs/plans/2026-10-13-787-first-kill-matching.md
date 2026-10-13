# Issue #787: first-kill assembly optimisation

Status: approved to build after folding in review 5506067965 on 13 October 2026.

## Outcome and current evidence

Preserve the assembled dossier byte for byte, including available zero,
unavailable and not_applicable evidence, while eliminating matching work across
unrelated characters and bosses. Keep HTTP no-store and existing logging/storage
contracts. No migrations, budget changes, collection-policy changes or deployment
actions are proposed.

Issue #787 and all its comments were read on 13 October 2026 (no comments existed
before pickup). Fresh origin/main is 7c21c89f. Its applicant-dossier.ts still maps,
filters and sorts every allKills entry per first kill and scans withheld kills.
raid-catalogue.ts still normalises repeatedly and reconstructs the reverse slug
lookup per first kill. synthetic-evidence.ts still omits first kills and rosters.
The historical premise therefore remains applicable. The issue's historical CPU
measurements have not yet been reproduced.

## Design

1. Extend the existing synthetic evidence generator and profiler seed publication
   with first kills and read rosters, retaining deterministic generated identities.
   Make the largest 14-character scenario exercise approximately 3,406 kills,
   14,464 wipes, 340 first kills and 4,100 roster members. Include a mixture of
   matched and standalone encounters and all three parse states. Verify the
   publication reaches dossier assembly, rather than only creating unused rows.
   Run profile:dossier before changing assembly, record assembly timings and a
   CPU profile where the existing profiler/runtime permits it.
2. Index eligible and withheld Warcraft Logs kills separately by canonical
   character ID and Raider.IO raid/boss slugs. Resolve catalogue identity and
   timestamp once per kill. Per first kill, inspect only its bucket; choose the
   nearest qualifying timestamp within STORED_KILL_MATCH_MS, using compareEvidence
   on ties and retaining original input order on exact ties. Read allKills[index]
   at selection time and reject entries already carrying raiderIoFirstKill.
   Preserve missing boss names, invalid timestamps, faction aliases and combined
   Midnight zone behaviour. Raider.IO-only appended kills already carry their
   first-kill object and cannot become eligible candidates.
3. Use bounded in-process memoisation for pure name normalisation, boss slug and
   raid/boss lookup (including null results). Initial bound: 4,096 entries per
   cache with oldest-entry eviction, independent of input volume. Cache keys
   encode tuples unambiguously. Hoist the combined-zone normalised constant.
   Build the reverse Raider.IO encounter index once from the catalogue, preserving
   first-in-boss-order selection only for the existing explicit same-raid override
   case, and preserving null for all other ambiguities.
4. Cache canonical IDs by immutable CharacterKey object using a WeakMap local to
   dossier assembly helpers, covering comparisons as well as matching. Use push
   accumulators (all four, including tier bests) and compute dossier roster
   membership with a Set. Preserve the
   existing case behaviour of dossier keys; do not broaden membership semantics
   for malformed/noncanonical inputs accidentally.

Index construction is O(kills); queries inspect only same-character/same-boss
candidates, independent of unrelated dossier volume. This follows the issue's
proposed bucket design. Arbitrarily repeated first-kill inputs for one bucket can
still multiply that bucket's work; do not claim a strict worst-case O(F + K)
bound for unrestricted duplicate inputs. If the Manager requires that stronger
bound, agree a time-index strategy before implementation.

## Test-first implementation and verification

- First add failing generator/publication tests and deterministic growth guards
  at production-shaped volume. Spy on String.prototype.normalize and Date.parse,
  which intercept actual internal work without exporting instrumentation seams.
  Compare F and 2F first kills at fixed K on both eligible and withheld paths.
  Use distinct cold, catalogue-equivalent spellings of valid raid and boss names
  for each build (punctuation variations stripped by normalisation), so persistent
  caches cannot hide the work. Assert that the extra normalisations/timestamp
  reads grow with F, not F times K; preserve output assertions alongside counts.
  No module-namespace/private-function spies or wall-clock-only unit assertions.
- Add focused equivalence cases for boundaries, nearest/tied kills, repeated
  first kills, ambiguous/faction catalogue entries, missing names and invalid
  dates. Extend existing tests rather than copying implementation into tests.
- Capture an assembled result before optimisation and compare JSON.stringify
  after optimisation on identical immutable inputs. Replay an actual stored
  dossier through the same domain builder before/after inside the test deployment
  when the coordinator agrees the concrete execution method. Use one REPEATABLE
  READ READ ONLY transaction and default read-only connection options. Keep live
  inputs in memory there; print only aggregate counts and before/after SHA-256
  hashes, never identifiers or input files. Do not download live rows locally.
  A synthetic replay alone
  does not satisfy the stored-dossier criterion.
- Record before/after local profiler evidence. Run the full Docker-backed gate:
  format:check, lint, typecheck, test:unit, test:integration, build, test:e2e.
  Self-review against origin/main, fetch and merge current origin/main, then
  repeat the full gate. Check all results for skipped suites.
- Convert this draft to an implementation PR only after those steps; Manager
  decides merging. Never merge or enable auto-merge from this chat.

## Deployment evidence and coordination

After Manager merge and test deployment, collect at least 10 count=14 ryun reads
and aggregate web assembleMs p50/max, deployment SHA and measurement window.
Acceptance is p50 below 1,000 ms against the historical 5,886 ms baseline.
Use existing aggregate logging; add no identifiers. Coordinate the access and
read load first. Local measurements do not satisfy deployment acceptance.

#788 stays queued until #787 lands and this measurement determines its remaining
scope. Coordinate overlapping domain work from #902 before modifying shared code.

## Decisions requested from Manager/coordinator

- Approve bucket matching, cache eviction and semantics-preserving membership.
- Confirm the deterministic guards and profile comparison adequately cover the
  regression, including the stated unrestricted-duplicate complexity caveat.
- Provide an authorised stored-input replay route and test deployment measurement
  route, or record these as outstanding external acceptance evidence.
