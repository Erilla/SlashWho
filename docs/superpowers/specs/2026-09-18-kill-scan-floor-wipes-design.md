# The kill scan floor has to answer for stored wipes

Closes #326.

The report scan's early stop was derived from a character's stored kills alone,
while the publish that depends on it keeps stored _kills and wipes_ on the same
condition. The two disagreed, and the disagreement became reachable the moment
#314 let the floor engage.

## The invariant, stated properly

A complete publish keeps only the stored evidence whose raid is terminal for
kills:

```ts
input.state === "partial"
  ? stored
  : {
      kills: stored.kills.filter((k) => terminalKillRaidIds.has(k.raidId)),
      wipes: stored.wipes.filter((w) => terminalKillRaidIds.has(w.raidId))
    };
```

That is lossless on one condition: **the scan only ever skips evidence in raids
that are terminal for kills.** `killScanFloorFrom` exists to guarantee it, and
it did so by taking the oldest _kill_ in a raid that is not terminal.

Wipes were outside that guarantee, and nothing else covered them.

## The gap

`terminalTiersFrom` builds its per-raid map from the run's kills. A raid with no
kill therefore produces no mark in any domain — there is nothing to settle. So a
raid a character has only ever wiped in can **never** be terminal for kills, and
the mark that would make the publish keep its wipes is unreachable.

Meanwhile `killScanFloorFrom` never saw those wipes, so they never held the
floor open. Concretely:

| Raid | Stored evidence  | Terminal for kills |
| ---- | ---------------- | ------------------ |
| 42   | kill, 2026-06-01 | yes                |
| 43   | wipe, 2026-03-01 | no — and can't be  |

Every raid with a kill is terminal, so the floor fell to the "everything held is
terminal" branch and came out at 2026-06-01, the newest kill. The scan stopped
above raid 43. The run published `complete` with nothing for raid 43, and the
filter dropped the wipe, permanently.

Raid 43 does not have to be wipe-only for this to bite: any raid whose kills are
all terminal while its wipes sit below the floor loses them the same way, and
the "everything terminal" fallback makes that the ordinary case for a veteran.

## Why it was invisible until now

These characters never published `complete` before #314. A veteran exhausts the
parse budget on every run, which made every run partial, and a partial publish
carries everything forward unconditionally — the filter was dead code for
exactly the population that now reaches it. #314 let the floor engage, which cut
the work per run enough for the run to finish inside its budget, and the filter
ran for the first time.

This is the shape of #250 and #252 again: a publish path discarding stored
evidence a later run did not re-find.

## The change

`killScanFloorFrom` takes the stored wipes as well as the stored kills and
weighs them identically: outstanding evidence is anything, kill or wipe, whose
raid is not terminal for kills, and the floor is the oldest of it. The
repository method that feeds it becomes `storedEvidenceTiers`, returning
`{ kills, wipes }` from the same `loadCompletedEvidence` read it already made —
no extra query.

The `undefined` guards are unchanged: a character with no stored kill still gets
no floor, so a character holding only wipes is scanned in full as before.

## What this does not change

- **Kills were never at risk.** The floor is the minimum over non-terminal
  kills, so no stored kill in a non-terminal raid can sit below it. That part of
  the invariant held, and the runs in #326's window did not lose kills by this
  mechanism.
- **Terminality is still settled by kills alone.** A wipe holds the scan open;
  it never marks a tier finished. Tying terminality to wipes would freeze a raid
  the character is still progressing in.

## Cost

The floor drops to the oldest outstanding wipe, so a character carrying old
wipes in a non-terminal raid pages further back than before — back to exactly
where correctness requires, and no further. Characters whose wipes all sit in
terminal raids are unaffected.

## Testing

- `killScanFloorFrom`: an outstanding wipe pulls the floor down; a terminal
  raid's own wipe does not; the oldest of a kill and a wipe wins; wipes with no
  kills still give no floor.
- The job handler passes the stored wipes through, so the gateway is told to
  page back to a wipe in a raid that was never killed in.
- `storedEvidenceTiers` returns the wipes a complete publish stored.
