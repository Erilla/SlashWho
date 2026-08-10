# Fingerprint sweep measurement prototype

## Purpose

Measure the live candidate-generation and achievement-fingerprint path that SlashWho would use for `Ictinus` on EU Argent Dawn. The prototype answers whether a bounded guild-roster breadth-first sweep has acceptable request volume, latency, payload weight, and discrimination for five known same-account characters.

## Scope

The throwaway CLI starts from `Ictinus`, enumerates reachable guild rosters breadth-first, and fetches achievement data for candidates until it reaches a hard ceiling of 3,000 Blizzard achievement requests. `Ictinus`, `Driptinus`, `Boptinus`, `Cryptinus`, and `Mistakinus` are ground truth for the same account. Raider.IO exposes no ownership or Warband links for `Ictinus`.

The prototype uses the Railway `test` worker environment at runtime. Credentials remain environment variables and are neither printed nor written to disk.

## Design

`scripts/prototypes/fingerprint-sweep-measurement.ts` is a clearly marked disposable CLI, run through a single package script. It:

1. Authenticates to Blizzard with the worker's runtime credentials.
2. Traverses guild rosters breadth-first from `Ictinus`.
3. Fetches candidate achievements transiently and measures each response's reported `Content-Length` when available, received-body size, and elapsed time.
4. Compares each candidate with `Ictinus` using shared achievement IDs and equal completion timestamps.
5. Immediately discards each raw response and derived fingerprint.
6. Prints one redacted JSON summary.

The summary contains candidate and request counts, elapsed time, payload-size distribution, score distribution, matches among the five known characters, cap status, and aggregate failure counts. It contains no credentials, raw responses, achievement identifiers, timestamps, or persisted fingerprints.

## Boundaries

The prototype performs no database writes and creates no snapshots. It does not change production worker behavior. API, transport, 429, and 5xx failures are counted in the summary only. The source remains on the `codex/prototype-fingerprint-sweep-measurements` scratch branch as the primary record of the measurement.

## Verification

Run the bounded measurement once through the Railway `test` worker environment:

```powershell
railway run --service worker --environment test -- pnpm prototype:fingerprint-sweep
```

Stdout is one redacted `MeasurementSummary`, which is the artifact to attach to the issue; no output file is created. The prototype is also checked with formatting, linting, type checking, and the unit suite. It intentionally has no automated tests of its own because it is a throwaway measurement tool.
