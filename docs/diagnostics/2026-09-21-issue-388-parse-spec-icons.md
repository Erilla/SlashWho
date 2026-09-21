# Issue #388: missing parse specialization icons

## Finding

The missing icons are caused by stale parse-specialization evidence becoming
terminal, not by an icon asset or React rendering defect.

The specialization fixes in #223 and #229 invalidate an evidence run through
`CURRENT_EVIDENCE_VERSION`, but terminal tiers use the independent
`CURRENT_COLLECTION_VERSIONS.parses` gate. That gate remains at `1`. A terminal
parse tier recorded at version 1 is therefore still skipped during later
collections, even when the later run has a newer global evidence version. The
publication path carries the stored no-specialization performance forward. The
dossier contract intentionally omits a null specialization, and the UI
intentionally omits the image for that field.

The affected character's old, now-concluded raid evidence is exactly the data
class that this gate protects from re-hydration. The result is valid parse
percentiles with no `spec`, hence rows without specialization icons.

## Red-capable reproduction

Run this read-only command from the repository. It loads the observed public
dossier in Chromium and fails if there are no available parse rows or if every
available parse row has an icon. It asserts the rendered symptom rather than an
HTTP success condition.

```powershell
@'
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("https://web-test-7765.up.railway.app/dossiers/eu/draenor/regnitrap?job=f56e76af-1405-43e0-bb7b-093a2411909d", { waitUntil: "networkidle" });
const result = await page.locator(".dossier-parse-list").evaluateAll((lists) => {
  const rows = lists.flatMap((list) => Array.from(list.querySelectorAll("li[role=group]")));
  const available = rows.filter((row) => row.querySelector("a.dossier-parse-metric"));
  const withIcon = rows.filter((row) => row.querySelector("img.dossier-parse-spec-icon"));
  return { available: available.length, withIcon: withIcon.length };
});
console.log(result);
if (result.available === 0 || result.withIcon === result.available) process.exitCode = 1;
await browser.close();
'@ | node --input-type=module -
```

On 2026-09-21 the command reported `{ available: 65, withIcon: 0 }`. The
underlying dossier endpoint was sampled three times immediately beforehand;
each result had `115/115` parse records without a `spec` field. No provider
payloads, credentials, or private database data are included here.

## Boundary trace

| Boundary                    | Observation                                                                                                                                                                                | Result                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Warcraft Logs normalization | `specPerformance` creates `{ name, iconUrl }` when ranking specialization data can be resolved. #223 and #229 added the relevant specialization and class handling.                        | The normalizer and icon lookup are not the direct cause of an absent API field. |
| Persistence                 | `publish` writes `spec_name` and `spec_icon_url`; when a fight is not re-hydrated it merges and carries stored performance forward.                                                        | Old null values survive a later collection.                                     |
| Collection eligibility      | The worker passes terminal parse raid ids into the gateway. Terminal parse tiers are omitted from both per-fight and zone-ranking hydration.                                               | A terminal tier cannot gain new specialization data.                            |
| Invalidations               | `CURRENT_EVIDENCE_VERSION` is 13, but `CURRENT_COLLECTION_VERSIONS.parses` is still 1. The terminal-tier contract explicitly says a domain collection-version bump is the correction path. | Global evidence invalidation cannot reopen these parse tiers.                   |
| Contract and UI             | `aggregateEventParses` leaves `spec` out when it is null; `DossierParseList` renders an image only when `spec` exists.                                                                     | The missing icon is the intentional final rendering of stale null data.         |

## Causal test and eliminated hypotheses

The repository integration test `omits a terminal tier recorded below its
domain's collection version` encodes the discriminating behavior: a parse mark
at an older collection version is excluded, while a mark at the current one is
terminal. Git history shows the terminal-tier feature introduced `parses: 1`
in #299 after #223/#229, and no commit has introduced `parses: 2`.

This makes the following predictions hold:

1. A stored parse tier marked at version 1 is supplied to
   `terminalRaidIds.parses`, so its old rows are not sent to ranking hydration.
2. A later global evidence-version refresh can complete and preserve those
   rows, but cannot improve their absent specialization metadata.
3. Raising only the parse collection version makes the mark ineligible and
   lets the ordinary bounded collection path re-read the tier.

The icon mapping/asset and UI hypotheses are falsified by the public API's
missing `spec` field. The serializer hypothesis is falsified by the explicit
database columns and domain rule that intentionally omits null specializations.

## Required follow-up

This diagnosis does not change production behavior. A separately scoped fix
should bump the `parses` collection version and add a regression test covering
a terminal tier whose stored performance predates specialization metadata. The
fix must preserve the terminal-tier cost boundary for `kills` and `tier_bests`,
and its verification should re-run this dossier only through the approved,
bounded collection workflow.
