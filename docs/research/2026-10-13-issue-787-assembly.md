# First-kill assembly measurements (#787)

The original first-kill scans remain on baseline `7c21c89f`. The replacement
indexes eligible and withheld kills by character and Raider.IO raid/boss slugs,
resolves and parses each candidate once, and retains distance, evidence and
stable input-order tie rules. Catalogue results are memoised in bounded pure
caches and the reverse slug index is built once. Character IDs are reused for
immutable keys; roster membership uses a Set and all four grouping accumulators
append in place. Neither HTTP caching nor upstream budgets change.

## Local measurements

The expanded `profile:dossier` largest scenario publishes 14 generated characters
with 3,406 kills, 14,464 wipes, 340 read first kills and 4,100 roster members. The
seed checks stored first-kill and roster counts after publication. Matched and
standalone first kills are both present. All traffic uses the local provider
fakes and Docker PostgreSQL; there is no injected database RTT.

| Measurement                      | Before         | After     |
| -------------------------------- | -------------- | --------- |
| Warm reads                       | 3              | 10        |
| Server `assemble` p50            | 1,672 ms       | 373 ms    |
| Server `assemble` max            | 1,674 ms       | 477 ms    |
| Serialised response bytes        | 4,548,537      | 4,548,537 |
| Synthetic domain builder, 3 runs | 1,371–1,478 ms | 71–119 ms |

Commands: `PROFILE_LOADS=3` then `PROFILE_LOADS=10`, each with
`corepack pnpm profile:dossier --grep 'largest production-sized'`. The builder
measurements use a separate CPU-profiled replay of generated inputs at the same
volume, including all three parse states and zero/null Vantus counts. Its
8,106,167-byte output has the same SHA-256 before and after:
`8d88460421ff8251d7ccb68c003831e17122b249a587a3a0e9471596911c159e`.
The baseline CPU profile's dominant named self-time frames were
`normalizedName` and `canonicalCharacterId`.

These are local samples, not deployment acceptance. Sample sizes differ, and
database, response and browser timings vary with machine load; the assembly
bucket and the fixed-input builder replay isolate the change more closely.

## Deterministic regression guards

Global `Date.parse` and `String.prototype.normalize` spies observe internal calls
without introducing a public instrumentation API. Compare 170 and 340 first
kills at fixed 3,406 kills, on eligible and withheld paths, using fresh raw
catalogue-equivalent spellings. The first kills lie outside the matching window
so the old scans cannot short-circuit on their first candidate. Metadata resolves
kill names to canonical catalogue names, so the timestamp guard remains decisive
even when catalogue name caches are warm.

Before the optimisation, the extra 170 first kills caused 705,855 more timestamp
parses on the eligible path and 83,400 on the withheld path. Both guards failed
the bound of 3,400 extra calls. They pass after indexing. Additional cases cover
nearest and evidence-tied kills across midnight, the inclusive two-hour bound,
already-replaced entries, and verbatim dossier-key roster membership. Existing
tests cover catalogue faction aliases, combined zones and evidence states.

## Stored-input replay on test

An authorised diagnostic ran once inside the existing test worker deployment,
receiving code over SSH stdin. It started no worker or queue consumer. Both the
baseline `7c21c89f` and proposed domain builders were bundled into that code;
stored inputs stayed in deployment memory and only aggregates and hashes left it.

The PostgreSQL pool used `default_transaction_read_only=on`. One dedicated client
held `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` for subject resolution and
completed-evidence loading, including suppression-filtered published Raider.IO
rosters. The web ceiling was unset, so the resolver used the existing default 50.
The diagnostic reused this outer snapshot for repository nested consistent reads.
A local Docker PostgreSQL test first demonstrated that a concurrent insertion
stayed invisible across those nested reads, isolation and read-only flags stayed
set, generic writes/transactions were rejected, and both success and SQL failure
rolled back and released the outer client. The deployed diagnostic verified the
transaction flags again before finishing and always rolled back/released.

| Input/output aggregate | Count     |
| ---------------------- | --------- |
| Selected characters    | 14        |
| Excluded / skipped     | 0 / 0     |
| Warcraft Logs aliases  | 0         |
| Completed / missing    | 14 / 0    |
| Kills                  | 3,407     |
| Wipes                  | 14,565    |
| Tier bests             | 85        |
| First kills            | 369       |
| Roster members         | 4,720     |
| Output bytes           | 6,611,818 |

The output was byte-identical. Both SHA-256 values were
`29c6b6ec878abe9d81f94bd43d388e931e8c95be7ce105f912050beff34d7936`.

Coverage is a fixed stored-evidence input to the domain builder. It includes
stored parse states, zero values, published first kills/rosters and stored scan
completion flags. It does not invoke request freshness reservations, upstream
rank repair, providers or service response metadata, and does not reproduce the
whole public HTTP read. No live input/output file was written or downloaded.

## Deployment acceptance still outstanding

After the reviewed implementation lands and test deploys it, take at least ten
count=14 reads and record deployment SHA, window, `assembleMs` p50 and max from
web logs. The issue requires p50 below 1,000 ms, against the historical 5,886 ms
baseline. Do not mark that criterion met from these local measurements. #788
remains queued until that remeasurement determines its remaining scope.
