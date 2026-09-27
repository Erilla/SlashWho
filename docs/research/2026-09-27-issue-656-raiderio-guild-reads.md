# Discovery's slow uncached Raider.IO guild reads

Issue #656. Investigated 2026-09-27 against `origin/main` at `28630a0f`.

## Question

Cycle 1 of discovery run `ed908d81` (eu/silvermoon/ryun, Railway test) spent
19,845 ms in 11 Raider.IO calls. One call took 10,002 ms, which is
`RAIDER_IO_TIMEOUT_MS`. That call was Ryeen's guild read, and the published
snapshot has no guild for Ryeen. `discoverCharacter`
(`packages/domain/src/discovery.ts`) makes all 11 calls one at a time. The
last loop reads one character payload per claimed character, only to learn
its guild. A failure there is swallowed and "costs one guild, never the
snapshot".

The issue asks five things:

1. Is the site API (`/api/characters/{region}/{realm}/{name}`) the right
   endpoint for a guild read, or would `/api/v1/characters/profile?fields=guild`
   be faster or more predictable when uncached?
2. Should the guild loop run with bounded concurrency, and what does that do
   to the Raider.IO allowance?
3. Should a guild read that times out be retried, perhaps with a shorter
   timeout?
4. Should a dropped guild read be counted on the run record?
5. Should `scopedRaiderIoGateway` name its calls?

## Answer

- **Endpoint: keep the site API.** v1 is faster at the median when uncached
  (212 ms against 760 ms), but its tail is no better (maximum 4.1 s against
  3.5 s over 30 reads each). Its `guild` also carries only the realm's
  display name (`"realm":"Silvermoon"`), not its slug. `CharacterGuild` needs
  the slug, and deriving one from a display name is guesswork for names such
  as `Kel'Thuzad` or `Aggra (Português)`. Switching would trade a known-good
  shape for a lossy one to shave the median, which is not the problem.
- **Concurrency: read guilds four at a time.** Cycle 1 then waits roughly on
  its slowest read instead of the sum. Four uncached reads in flight were no
  slower per call than serial reads. Four matches the Raider.IO ranking reads
  the evidence run already makes (`RAIDER_IO_RANKING_CONCURRENCY`). The
  request count does not change: the loop is still charged against
  `DISCOVERY_REQUEST_CAP` (40), so a run spends the same requests, just over
  a shorter time.
- **Timeouts: keep 10 s, and retry a timed-out or 5xx guild read once.** Do
  not shorten the timeout. A read abandoned by the client is still completed
  by Raider.IO and cached at Cloudflare, and a retry joins that fetch rather
  than starting a new one. So a retry recovers the slow read almost for free,
  while a shorter timeout only moves the cut-off: a 12 s read aborted at 5 s
  and retried with 5 s is still dropped. Do not retry a 429, 403 or 404.
  Charge the retry to the same request budget, so the cap stays a hard
  ceiling.
- **Visibility: yes.** Count guild reads that end without a guild because of
  a failure (not a guildless answer, not budget exhaustion). Record the count
  on the `discovery_runs` row and in the `discovery_run` log record. The
  snapshot is immutable, so a dropped guild stays dropped until the next
  refresh, and today nothing records that it happened.
- **Log naming: yes, by operation only.** Pass the operation name
  (`getCharacter`, `getClaimedCharacters`, `resolveProfileGuess`) as the
  `label` argument that `MeasurementScope.time` already accepts, giving
  `raiderIoMaxCallName`. Never label a call with its argument: an owner id
  or a profile guess must not reach the logs.

Follow-up issues: #676 (concurrency), #677 (retry and dropped count),
#678 (log naming).

## How it was measured

This was a one-off run of live traffic from a workstation, on 2026-09-27
between about 12:55 and 14:15 UTC, a Sunday. Cloudflare served it from its
London edge (`CF-RAY … -LHR`). Railway reaches a different edge, so absolute
numbers will differ there. The comparisons between endpoints and between
first and repeated reads should hold. Nothing here runs in the pull-request
gate, and the scripts were not committed. The raw results list timings only:
no character names were written down.

**Finding uncached characters.** An uncached read is one Raider.IO has not
served recently. Characters were sampled from the lowest guild ranks
(`fields=members`) of guilds on pages 60–120 of the Manaforge Omega heroic
rankings (`/api/v1/raiding/raid-rankings`), in both regions. Every first read
in the samples below came back `cf-cache-status: MISS`, so none was
pre-warmed at the edge.

**Endpoints compared.** Both carry the `SlashWho` user agent the client sends,
with no access key:

- site: `/api/characters/{region}/{realm}/{name}`, which
  `createRaiderIoClient.getCharacter` calls today.
- v1: `/api/v1/characters/profile?region=…&realm=…&name=…&fields=guild`.

**Sequence.** Set A (30 characters): site cold, then v1, then site again.
Set B (30 other characters): v1 cold, then site, then v1 again. There was a
250 ms pause between requests. Set C (30 more characters): site cold, four at
a time, in eight batches. A separate retry experiment is described under
[Timeouts and retries](#timeouts-and-retries).

## Results

### Uncached latency by endpoint

| Read                        | n   | min    | p50    | mean     | p90      | max       | over 2 s |
| --------------------------- | --- | ------ | ------ | -------- | -------- | --------- | -------- |
| site, cold (set A)          | 30  | 249 ms | 760 ms | 1,389 ms | 3,343 ms | 3,526 ms  | 9        |
| v1, cold (set B)            | 30  | 139 ms | 212 ms | 615 ms   | 1,587 ms | 4,134 ms  | 2        |
| v1, after a cold site read  | 29  | 129 ms | 153 ms | 186 ms   | 298 ms   | 456 ms    | 0        |
| site, after a cold v1 read  | 30  | 234 ms | 505 ms | 1,199 ms | 4,194 ms | 5,415 ms  | 5        |
| site, repeated (edge `HIT`) | 30  | 16 ms  | 19 ms  | 20 ms    | 23 ms    | 28 ms     | 0        |
| v1, repeated (edge `HIT`)   | 30  | 16 ms  | 18 ms  | 20 ms    | 25 ms    | 33 ms     | 0        |
| site, cold, 4 in flight (C) | 30  | 195 ms | 413 ms | 1,052 ms | 1,829 ms | 15,359 ms | 2        |

What this shows:

- **The fast second read in the issue is Cloudflare, not Raider.IO.** Every
  repeated read was an edge `HIT` at about 20 ms. The site API is cacheable
  for 60 s (`Cache-Control: max-age=60`), v1 for 300 s. A replay within a
  minute will always look fast, whatever the origin is doing.
- **v1 has the lower median but not a shorter tail.** Its slowest cold read
  (4.1 s) was slower than the site API's slowest in the same sequence.
- **The two endpoints share some backend work but not their caches.** A v1
  read right after a cold site read was fast (p50 153 ms), so the site read
  warmed something v1 uses. The reverse did not hold: a site read after a cold
  v1 read was still slow (p50 505 ms, maximum 5.4 s).
- **Reads over 10 s are rare but real.** 1 of 60 cold site reads (sets A and
  C) took 15.4 s. The issue saw one of 11. Which character is slow did not
  repeat between runs.
- **The data agrees.** Both endpoints gave the same guild in 59 of 60 pairs.
  The 60th was a transient 502 from v1.

### Shape of the guild

The site payload carries the guild's realm as an object with a `slug`, which
`normalizedGuild` (`packages/raiderio/src/normalize.ts`) reads. v1's
`fields=guild` gives `{"name":"SeriouslyCasual","realm":"Silvermoon"}`: a
display name and no slug or region. The site payload is much larger (about
82 KB for Ryun against about 0.5 KB), but transfer is not what makes a cold
read slow: repeated site reads of the same payload take 20 ms.

### Concurrency

Set C's eight batches took 23.3 s of wall time. The same 30 reads, made one
after another, would have taken 31.6 s, the sum of their durations. One
15.4 s read dominates both figures. Without that batch, the other seven took
7.9 s against a summed 16.2 s. Per-call latency with four in flight (p50
413 ms) was no worse than serial (p50 760 ms). The two sets hold different
characters, so read that as "no sign of slowing", not as "faster". There was
no 429 or other non-200 response in set C.

For cycle 1 of `ed908d81`, the relationship reads (root, declared main,
claimed characters) stay serial because each depends on the last. The guild
reads for eight or nine characters would take about as long as the slowest
one, not the sum.

### Timeouts and retries

Ninety further cold site reads were made with a 400 ms client timeout. The
52 that timed out were retried once, 1 s later, with no timeout:

| Retry of an abandoned read | Count |
| -------------------------- | ----- |
| 60 ms or less              | 37    |
| 0.3–3 s                    | 11    |
| 4.3–8.0 s                  | 4     |

Every retry was an edge `HIT` and returned 200. Abandoning a read does not
abandon Raider.IO's work: Cloudflare finishes the origin fetch, caches it, and
a retry is either served from that cache or joins the fetch still in flight.
That is also why the issue's second pass found Ryeen's guild at once.

So, for the guild loop:

- **A retry recovers the read that timed out.** Ryeen's read, abandoned at
  10 s, would almost certainly have been answered by one retry.
- **A shorter timeout plus a retry does not help.** The retry waits on the
  same origin fetch, so what counts is the total time allowed. A 12 s read
  is dropped by 5 s + 5 s, and kept by 10 s + 10 s.
- **A retry costs one request, not one origin crawl.** It is still a request
  against the allowance, so it must come out of `DISCOVERY_REQUEST_CAP` like
  the read it repeats.

With four in flight, the worst case for cycle 1 is one read that fails twice:
about 20 s. That is no worse than today's 19.8 s, and it only happens when
Raider.IO takes more than 20 s. The common case improves from the sum of the
reads to the slowest one, and a read between 10 s and 20 s keeps its guild.

## The Raider.IO allowance

Raider.IO publishes no number. The OpenAPI description
(`https://raider.io/openapi.json`, version 0.62.5, read 2026-09-27) says only
that unauthenticated requests are rate limited. A request over the limit gets
a 429 carrying `Retry-After` (whole seconds), `X-RateLimit-Limit`,
`X-RateLimit-Remaining` and `X-RateLimit-Reset`. Registered applications get
"higher request rates". No rate-limit header appeared on any 200 in these
runs, so the limit could not be read from a normal response. The access key is
only sent to `/api/v1/` paths (`packages/raiderio/src/client.ts`, `request`),
so the site API reads discovery makes are anonymous whether or not
`RAIDER_IO_ACCESS_KEY` is set.

With no published figure, the arithmetic is about bounding what changes:

| Consumer                          | In flight | Per unit of work                                                |
| --------------------------------- | --------- | --------------------------------------------------------------- |
| Discovery, relationship reads     | 1         | Root, declared main, claimed list or profile guesses            |
| Discovery, guild reads (proposed) | 4         | One per claimed character without a guild                       |
| Discovery, whole run              | —         | At most `DISCOVERY_REQUEST_CAP` = 40 requests, retries included |
| Evidence run, boss rankings       | 4         | At most 50 per run (`MAX_RAIDER_IO_RANKING_REQUESTS_PER_RUN`)   |
| Evidence run, historic tiers      | 3         | At most 17 per character (`raiderIoHistoricTiers`)              |
| Web, dossier read                 | request   | Root character payload and boss rankings per search             |

- **Request count per run is unchanged.** Concurrency changes when the 40
  requests are spent, not how many. Retries come out of the same 40.
- **The burst is bounded.** At four in flight and the fastest observed cold
  read (about 130 ms), the guild loop peaks near 30 requests a second, for at
  most its share of 40 requests: under two seconds. Edge `HIT`s could be
  faster, but the loop only reads characters the run has not read yet, so its
  reads are the uncached ones.
- **Four in flight is already the precedent.** The evidence run's ranking
  reads use four against the same host, and discovery and evidence runs are
  both serial per worker (one job at a time), so the combined in-flight peak
  is 4 + 4 + 3 plus the web's own reads.
- **The failure is contained.** A guild read is optional. A 429 there still
  costs only that guild, as today, and is not retried. The relationship
  reads, which do fail the run, stay serial and are not affected.

If a 429 ever shows up in discovery, the next step is a shared Raider.IO
limiter that honours `Retry-After`, like the Blizzard client's. Nothing
measured here calls for one yet.

## Not recommended

- **Switching guild reads to v1.** See [Shape of the guild](#shape-of-the-guild).
- **Shortening `RAIDER_IO_TIMEOUT_MS`.** It is shared by every Raider.IO call,
  including the relationship reads that fail the run, and a shorter timeout
  plus a retry recovers less than the current timeout plus a retry.
- **Filling guilds from Blizzard.** Discovery's Blizzard work is the
  fingerprint sweep, which reads guild rosters and achievement profiles, not
  each claimed character's profile. Adding a Blizzard profile read per
  character would move the cost to a different allowance, not remove it.

## Caveats

- The workstation's edge is not Railway's. The Railway figures in the issue
  (a 10 s timeout in 11 calls) are consistent with the tail seen here.
- Sixty cold site reads is enough to show a heavy tail and a rare read over
  10 s. It is not enough to put a number on how rare.
- This was Sunday afternoon in Europe. Raider.IO's origin load, and so the
  tail, will vary with the time of day and the point in the season.
