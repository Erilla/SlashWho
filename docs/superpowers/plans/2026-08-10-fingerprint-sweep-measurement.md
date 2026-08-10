# Fingerprint Sweep Measurement Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a disposable CLI that measures a live, 3,000-request-capped Blizzard achievement-fingerprint breadth-first guild sweep seeded from `Ictinus`.

**Architecture:** A standalone TypeScript script owns all live HTTP requests and summary aggregation; it has no dependency on the application database or worker runtime. It obtains Blizzard credentials only from the process environment supplied by `railway run`, holds achievement data only long enough to compare it, and emits one redacted JSON report to stdout.

**Tech Stack:** Node 22, TypeScript, `tsx`, native `fetch`, Raider.IO public API, Blizzard OAuth client-credentials and Profile APIs.

## Global Constraints

- Run only against the Railway `test` worker environment.
- Begin at `eu / argent-dawn / ictinus`; ground-truth same-account characters are `ictinus`, `driptinus`, `boptinus`, `cryptinus`, and `mistakinus`.
- Traverse guild rosters breadth-first and never make more than 3,000 achievement requests.
- Do not print or persist client credentials, raw responses, achievement IDs, completion timestamps, or derived fingerprints.
- Do not write to PostgreSQL, create snapshots, or modify production worker behavior.
- Count transport, 429, and 5xx outcomes in the final summary; do not treat them as non-matches.
- The tool is a prototype: it has no automated tests and remains on the scratch branch after the decision is captured.

---

## File structure

- Create: `scripts/prototypes/fingerprint-sweep-measurement.ts` — disposable live sweep, bounded traversal, transient comparison, and redacted report.
- Modify: `package.json` — adds the one-command prototype runner only.
- Modify: `docs/superpowers/specs/2026-08-10-fingerprint-sweep-measurement-design.md` — adds the final run command and report contract once they are implemented.

### Task 1: Implement the disposable live measurement CLI

**Files:**

- Create: `scripts/prototypes/fingerprint-sweep-measurement.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET` from the process environment, plus public Raider.IO and Blizzard Profile endpoints.
- Produces: `Promise<void>` from `main()` and exactly one JSON `MeasurementSummary` on stdout.

- [x] **Step 1: Add the executable package script**

Add this exact script entry to `package.json`:

```json
"prototype:fingerprint-sweep": "tsx scripts/prototypes/fingerprint-sweep-measurement.ts"
```

The single live-run command is:

```powershell
railway run --service worker --environment test -- pnpm prototype:fingerprint-sweep
```

- [x] **Step 2: Define the prototype-only data shapes and fixed sample**

At the top of `scripts/prototypes/fingerprint-sweep-measurement.ts`, add a `/** PROTOTYPE — ... */` comment that states the question and no-persistence boundary. Define the fixed root, known-character set, hard limit, and pure comparison result:

```ts
type CharacterKey = Readonly<{ region: "eu"; realm: string; name: string }>;
type Fingerprint = ReadonlyMap<number, number>;
type Match = Readonly<{
  common: number;
  identical: number;
  percent: number;
  isMatch: boolean;
}>;

const root: CharacterKey = {
  region: "eu",
  realm: "argent-dawn",
  name: "ictinus"
};
const knownCharacters = new Set([
  "ictinus",
  "driptinus",
  "boptinus",
  "cryptinus",
  "mistakinus"
]);
const requestCap = 3_000;
const minCommonAchievements = 200;
const matchPercentThreshold = 20;
```

Implement `compareFingerprints(left, right): Match` by counting common achievement IDs, equal timestamps, percentage, and the two existing threshold checks. Keep this function pure and do not serialise a fingerprint.

- [x] **Step 3: Implement credential, OAuth, and measured Blizzard requests**

Implement:

```ts
function requiredEnvironment(
  name: "BLIZZARD_CLIENT_ID" | "BLIZZARD_CLIENT_SECRET"
): string;
async function getAccessToken(
  clientId: string,
  clientSecret: string
): Promise<string>;
async function measuredJson(
  url: URL,
  token: string
): Promise<{
  status: number;
  elapsedMs: number;
  contentLength: number | null;
  receivedBytes: number;
  body: unknown;
}>;
```

`getAccessToken` posts `grant_type=client_credentials` to `https://oauth.battle.net/token` with HTTP Basic authentication. `measuredJson` uses `fetch`, records elapsed time with `performance.now()`, reads the body once as an `ArrayBuffer`, records `Content-Length` when present and the received-body byte length, then parses JSON from the bytes. It must never log its URL authorization header, token, or body.

For a successful achievements response, extract only entries with both numeric `id` and numeric `completed_timestamp` into a local `Map<number, number>`. Do not retain that map after the candidate has been compared. Classify a non-2xx status into `not_found`, `rate_limited`, `server_error`, or `other_http`; increment its aggregate count and return no fingerprint.

- [x] **Step 4: Implement root guild lookup and bounded breadth-first traversal**

Use Blizzard's Character Profile endpoint for the root to obtain its current guild name and guild realm. Use the Blizzard Guild Roster endpoint for each queued guild. Identify a guild by normalized `realm/name`, track `visitedGuilds`, and queue each new roster exactly once.

Use this traversal state:

```ts
type Guild = Readonly<{ realm: string; name: string; depth: number }>;
const guildQueue: Guild[] = [rootGuild];
const visitedGuilds = new Set<string>();
const seenCharacters = new Set<string>();
let achievementRequests = 0;
let capReached = false;
```

For each roster member, skip the root and previously seen characters. Before the achievements request, stop and set `capReached = true` when `achievementRequests === requestCap`. Fetch one candidate at a time so the hard cap and response metrics are exact. For a matching candidate only, look up its current Character Profile and enqueue its guild at `depth + 1` if unseen; do not expand non-matches. This preserves the production-shaped BFS without requiring storage or cached fingerprints.

- [x] **Step 5: Aggregate and print only the redacted report**

Maintain aggregate counters for roster requests, candidate count, achievement requests, guild count, total elapsed time, response `Content-Length` values, received-body byte values, score values, failure classes, known-character comparisons, and matched-character count. Print exactly one object shaped as:

```ts
type MeasurementSummary = Readonly<{
  root: CharacterKey;
  requestCap: number;
  capReached: boolean;
  guildsVisited: number;
  candidatesConsidered: number;
  achievementRequests: number;
  wallTimeMs: number;
  payloadBytes: {
    contentLength: {
      count: number;
      min: number | null;
      median: number | null;
      max: number | null;
    };
    receivedBody: {
      count: number;
      min: number | null;
      median: number | null;
      max: number | null;
    };
  };
  scores: {
    count: number;
    min: number | null;
    median: number | null;
    max: number | null;
  };
  knownCharacters: Record<
    string,
    {
      encountered: boolean;
      common: number | null;
      identical: number | null;
      percent: number | null;
      isMatch: boolean | null;
    }
  >;
  matchedCharacters: number;
  failures: Record<
    | "not_found"
    | "rate_limited"
    | "server_error"
    | "other_http"
    | "transport"
    | "schema",
    number
  >;
}>;
```

Sort numeric arrays before computing median. Keep all character names except the five fixed ground-truth names out of the report. In a top-level `main().catch`, emit a non-zero exit code only after writing a summary containing the aggregate failure count; never dump an exception response body.

- [x] **Step 6: Run static validation without invoking live Blizzard calls**

Run:

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
```

Expected: formatting, linting, type checking, and unit tests pass. Do not add automated tests for this throwaway prototype. The full integration suite remains blocked locally because Docker Desktop's Linux container engine is unavailable.

- [x] **Step 7: Commit the prototype implementation**

```powershell
git add package.json scripts/prototypes/fingerprint-sweep-measurement.ts
git commit -m "chore: add fingerprint sweep measurement prototype"
```

### Task 2: Run and capture the live measurement

**Files:**

- Modify: `docs/superpowers/specs/2026-08-10-fingerprint-sweep-measurement-design.md`

**Interfaces:**

- Consumes: the Task 1 runner and Railway `test` worker environment.
- Produces: a redacted summary pasted into the prototype ticket as the measurement result; the branch is the primary source for the code.

- [x] **Step 1: Execute one bounded live sweep**

Run exactly once:

```powershell
railway run --service worker --environment test -- pnpm prototype:fingerprint-sweep
```

Expected: one JSON summary, no credentials or raw upstream data in stdout, and no more than 3,000 achievement requests.

- [x] **Step 2: Check the report against ground truth and safety boundaries**

Confirm from the JSON summary that all five named known characters have an `encountered` value, compare their `isMatch` and score fields, record whether the request cap was reached, and record the payload-byte and wall-time distributions. Confirm the report contains no unknown roster-member name, achievement ID, timestamp, credential, or response body.

- [x] **Step 3: Amend the design with the exact runner contract**

Append this command to the design's Verification section:

```powershell
railway run --service worker --environment test -- pnpm prototype:fingerprint-sweep
```

Add one sentence that stdout is a redacted `MeasurementSummary` and is the artifact to attach to the issue; no output file is created.

- [x] **Step 4: Commit the finalized prototype record**

```powershell
git add docs/superpowers/specs/2026-08-10-fingerprint-sweep-measurement-design.md
git commit -m "docs: record fingerprint sweep runner"
```

## Self-review

- Spec coverage: Task 1 implements live BFS, a 3,000-request ceiling, transient achievement processing, payload/timing/score metrics, redaction, and failure aggregation. Task 2 executes the sole permitted live run and captures the artifact.
- Placeholder scan: the plan contains no unfilled work markers or delegated implementation choices.
- Type consistency: `CharacterKey`, `Fingerprint`, `Match`, and `MeasurementSummary` are defined in Task 1 and are the only script-owned interfaces referenced later.
