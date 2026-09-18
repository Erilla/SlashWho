# Domain-aware tier trouble

A veteran re-scans their whole report history on every run. The cause is not
that terminality is too strict, but that parse-domain trouble is applied to the
kills domain, where it does not belong. Separating them lets the scan floor
engage without weakening what "complete" means.

Closes #304.

## The observed problem

`killScanFloorFrom` in `packages/application/src/terminal-tiers.ts` gives the
history scan an early stop, but it returns `undefined` whenever no tier is
terminal for kills. Measured on the 2026-09-18 sweep (`4e3d2d30`):

```
kills=244  terminal=9    kills=553  terminal=9
kills=779  terminal=0    kills=874  terminal=0    kills=217  terminal=0
```

Five of eight runs marked nothing, and the two largest characters — the ones
whose scans cost the most — never settle. The saving is unavailable exactly
where it would matter most.

## Diagnosis

#304 proposed that the fix required a weaker, lossier floor rule. Tracing the
code shows a different cause, and one that costs nothing to fix.

**Every write to `troubledRaidIds` is parse-domain.** In
`packages/warcraftlogs/src/client.ts` the set is written in exactly two regions:

- the zone-rankings loop (lines 1582–1632), covering a failed or drifted
  `CharacterZoneParses` response and every zone the zone budget did not reach;
- `troubleGroups` (lines 1720–1846), covering fight-parse hydration — a failed
  `ReportFightParses`, a failed identity lookup, and the `parse_request_cap`
  that stops the hydration loop.

Nothing in the history scan ever writes to it. Scan trouble is reported
separately as `limitation`, which `terminalTiersFrom` already handles by
returning no marks at all.

**But `terminalTiersFrom` applies that parse-domain set to all three domains**
(`terminal-tiers.ts:78`):

```ts
if (troubled.has(raidId)) continue; // blocks kills, parses AND tier_bests
marks.push(
  { raidId, domain: "kills" },
  { raidId, domain: "parses" },
  { raidId, domain: "tier_bests" }
);
```

Its own doc comment already draws the distinction the code then discards. Rule 2
says a raid-attributed limitation is about that raid's parses, while "a
limitation on the history scan leaves _every_ raid re-queryable, because a
truncated or drifted scan may be missing reports from any tier — kills and
wipes, not merely parses".

So the mechanism is: a veteran exhausts `parseRequestCap` (24) across zones and
hydration on every run → `troubleGroups` marks nearly every raid troubled → no
raid goes terminal for kills → `killScanFloorFrom` returns `undefined` → the
full history is re-scanned. The characters that never settle do so because of
the parse budget, not because of anything the kill scan did.

## Decision

**Split `troubledRaidIds` by collection domain, and stop letting parse-domain
trouble block the kills mark.** The clean-history-scan rule is untouched.

```
WarcraftLogsReportResult:
  troubledRaidIds: {
    parses:    readonly string[]
    tierBests: readonly string[]
  }

terminalTiersFrom:
  kills      <- blocked only by scanLimitation
  parses     <- blocked by troubled.parses
  tier_bests <- blocked by troubled.tierBests
```

Writes map onto domains exactly as the code already groups them: every
zone-loop write becomes `tierBests`, every `troubleGroups` write becomes
`parses`.

### Why this takes no trade-off

`terminalRaidIds.kills` is consumed in exactly one place: `killScanFloorFrom`.
The gateway reads only `.parses` (`client.ts:1674`, gating hydration) and
`.tierBests` (`client.ts:1573`, gating zone requests). Marking a raid terminal
for kills therefore has a single effect — it lets the scan stop paging below
that raid. It drops no kill, skips no ranking request, and withholds nothing
from the dossier.

The completeness guarantee behind the kills mark is unchanged: a raid still goes
terminal for kills only after a run whose history scan raised no limitation at
all. A log backfilled into an older tier is still found by the next clean scan,
because that scan still reaches it. There is no loss to record.

This is the reason to prefer it over the rule #304 proposed. Flooring at the
newest stored kill regardless of terminality would take a permanent loss in
completeness; worse, on a character whose stored history is itself incomplete it
would stop the scan before ever reaching the gap. The domain split solves the
same problem for free.

### What this explicitly does not change

- `terminalTiersFrom`'s three rules. Window conclusion, the clean-read rule and
  kill settling all stand as written.
- The meaning of "complete". No evidence becomes unreachable that was reachable
  before.
- The gateway's spending decisions. `.parses` and `.tierBests` still gate
  requests exactly as they do today.

## Invariants that need rewording

Both of these currently justify the guard in whole-tier terms, which stops being
accurate once the domains are separated. Neither statement becomes false — the
reasoning behind them has to become explicit that parse trouble says nothing
about kill completeness.

- **`killScanFloorFrom`'s doc comment** derives its safety from "a tier only goes
  terminal for kills after a run whose history scan raised no limitation". Still
  true, and now the only thing the kills mark depends on. The comment should say
  so directly rather than leaving it as one clause among three.
- **`docs/superpowers/specs/2026-09-18-concluded-tier-retention-design.md`**,
  section "Terminal requires a clean read", states the guard as "a tier only goes
  terminal if the run that read it reported no limitation for it". That needs to
  become per-domain: a limitation attributed to a raid blocks the domain it was
  raised against, while a history-scan limitation blocks every domain of every
  raid.

## Sizing

The saving is "pages above the oldest unsettled tier", not the full 500-page
cap — at `REPORTS_PER_PAGE = 10` a veteran's scan almost certainly exhausts
naturally well before the cap. Taken against the #308 counters, the scan is at
least 68–86% of a run's cost at s ≥ 21.1 points per page, so even a partial
reduction is worth having.

That bound is derived, and the derivation should be falsifiable rather than
inherited. It solves

```
124s − 3z + 3f = 2617.67
```

for the per-page scan cost `s`, under the judgement that **z ≥ f**: a zone
request spans a whole tier across three metric aliases, where a fight-parse
request covers a single report. Relax `z ≥ f` and the lower bound moves. It is
one judgement, not a measurement, and a reader who disagrees with it should
recompute rather than trust the figure.

Nothing in the decision rests on it. Because this version costs nothing in
completeness, it is worth doing whatever the measured size turns out to be. The
counters from #303 remain the way to confirm the effect after it ships.

### Reading the records afterwards

**`killCount` will fall for veterans once this ships, and that is the fix
working.** The floor means the scan returns fewer kills per run, so the number
on an `evidence_job` record drops — it measures what one run re-read, not what
the character has. Worth knowing before someone reads the drop as evidence loss
at a glance.

What makes it safe is that `publish` carries stored kills forward, and it is
keyed on precisely the marks this change creates. A partial publish carries
everything forward. A complete publish carries forward the kills and wipes of
terminal kill raids, and drops the rest — "a kill a complete run stopped finding
stops being claimed". So a raid below the floor keeps its kills exactly because
it is terminal for kills, which is the same condition that let the scan stop
above it. The two rules are the same rule seen from either end; changing one
without the other would lose evidence.

> **Correction (#326).** That last paragraph held for kills and not for wipes.
> `publish` filters stored wipes by the same terminal-kill marks, but
> `killScanFloorFrom` derived the floor from stored kills alone, so the two
> rules were _not_ the same rule: a raid a character has only ever wiped in has
> no kill to settle and so can never be marked terminal, yet the floor could sit
> above its wipes and a complete publish then dropped them. Fixed by giving the
> floor the stored wipes too — see
> [`2026-09-18-kill-scan-floor-wipes-design.md`](2026-09-18-kill-scan-floor-wipes-design.md).

## Risks

- **A raid terminal for kills but troubled for parses is a new state.** It is
  the state this change exists to create, and it is already representable —
  `character_terminal_tiers` is keyed per domain and `TerminalTier` carries one.
  What is new is that it will now occur routinely rather than never.
- **The kills mark now rests on a single guard — checked, and it holds.**
  Previously the parse-domain trouble set masked any weakness in the
  scan-limitation check. If a history scan could ever fail without raising a
  limitation, kills would be frozen incomplete.

  The worst case is the population this change targets: a very large character
  whose scan silently truncates at the page cap and then has its incomplete
  kills frozen terminal. It cannot happen. The scan loop sets a limitation on
  exhausting its cap (`client.ts`):

  ```ts
  if (page === options.requestCap) {
    scanLimitation = { kind: "limitation", code: "request_cap" };
  }
  ```

  `terminalTiersFrom` returns no marks at all when `scanLimitation !== null`, so
  a truncated scan settles nothing, in any domain. The other exits are covered
  the same way: `hasMoreReportPages === null → schema_drift`, and the per-page
  limitation checks. All unchanged by this design.

- **Sizing is still derived, not measured end to end.** The effect on run cost
  should be confirmed from the #303 counters on the next sweep.

## Testing

- `terminalTiersFrom` marks a raid terminal for kills while withholding
  `parses` when that raid is troubled for parses only.
- `terminalTiersFrom` withholds `tier_bests` alone when a raid is troubled for
  tier bests only.
- `terminalTiersFrom` still returns no marks at all when `scanLimitation` is
  set, whatever the trouble sets say.
- The gateway attributes a zone-rankings failure to `tierBests` and a hydration
  failure to `parses`, and the zones beyond the zone budget to `tierBests`.
- The evidence job, given a run whose parses are troubled but whose scan was
  clean, marks kills terminal and so supplies a `killScanFloor` on the next run.
