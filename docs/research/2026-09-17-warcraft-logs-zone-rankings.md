# Best parses from `zoneRankings`

Issue #269, which recorded the live check against the public Warcraft Logs v2
client API on 2026-09-17 using `eu/kazzak/ashifell` and zone 44. The response
shapes and figures below are that check's; they have not been re-run here.

## The problem this replaces

A dossier's boss card carries two parse rows. They answer different questions,
but both were assembled the same expensive way — from `Report.rankings`, one
request per report.

| row               | what it wants            | what report rankings cost         |
| ----------------- | ------------------------ | --------------------------------- |
| First kill parses | that exact fight's parse | correct, and unavoidable          |
| Best parses       | the character's best     | one request per report, unbounded |

`EVIDENCE_PARSE_REQUEST_CAP` defaults to 8, so the best row was assembled from
whatever reports the budget happened to reach. On `eu/kazzak/ashifell` that was
17 of 30 bosses, and the value shown could be _worse_ than the character's real
best, because the better kill sat in a report the budget never reached. One
character on `eu/silvermoon/ryii` spans 353 reports; no per-report budget covers
that.

## Verified: one request per zone, all three metrics

`zoneRankings` is a field on `characterData.character`, returning a JSON scalar.
The three metrics alias into a single request, and each returns every encounter
in the zone:

```graphql
query CharacterZoneParses(
  $name: String!
  $realm: String!
  $region: String!
  $zoneID: Int!
) {
  characterData {
    character(name: $name, serverSlug: $realm, serverRegion: $region) {
      damage: zoneRankings(
        zoneID: $zoneID
        metric: dps
        difficulty: 5
        timeframe: Historical
      )
      healing: zoneRankings(
        zoneID: $zoneID
        metric: hps
        difficulty: 5
        timeframe: Historical
      )
      bossDamage: zoneRankings(
        zoneID: $zoneID
        metric: bossdps
        difficulty: 5
        timeframe: Historical
      )
    }
  }
}
```

```
damage      encounters=8
healing     encounters=8
bossDamage  encounters=8
```

Each `rankings` entry carries what the row needs:

```
encounter { id name }, rankPercent, medianPercent, totalKills,
spec, bestSpec, bestAmount, bestRank, allStars
```

```
Plexus Sentinel         best=96.2  spec=Destruction  totalKills=8
Loom'ithar              best=96.2  spec=Destruction  totalKills=10
Soulbinder Naazindhri   best=93.4  spec=Destruction  totalKills=9
```

The cost does not merely shrink — it stops scaling with history. One request per
(character, zone) is roughly 16 for a full history and 1 for the current tier.

## What the numbers mean, and what changed because of it

`rankPercent` on a `zoneRankings` entry is the character's **best** percentile
for that encounter, anywhere. It is not a fight. So the row it feeds is no
longer "best of the evidence shown below it": a value may come from a kill
outside the raid's current-content window, which the dossier deliberately
withholds.

That was a deliberate decision, not an implementation detail. The row is now
**Best parses** and means the character's best. A recruiter reading "best"
wants the character's best, and the per-fight evidence is the other row's job.
Because it is not a fight, an available value links to the character's own
rankings rather than to a report:

```
https://www.warcraftlogs.com/character/<region>/<realm>/<name>#zone=<id>&boss=<encounter>&difficulty=5
```

`bestSpec` is the specialisation the reported ranking was set in — `spec` is
only the character's most recent one, so it is the fallback. This is why
specialisation icons now reach the best row without depending on hydration
reaching the right report.

## This is not a re-introduction of what #237 removed

#237 removed `characterEncounterRankings` because a character-level best was
being written onto **every kill**, so a boss's first-kill parse showed a best
from some other night. That fix was right. What it also removed, without
replacement, was the cheap path for the one row where a character-level best is
the correct answer.

The two are now strictly separate, and nothing crosses between them:

- **First kill parses** — per-fight report rankings only. Never a character best.
- **Best parses** — `zoneRankings` only. Never a claim about a specific fight.

## Sharp edges

- **The zone id is the fight's, not the catalogue's.** Warcraft Logs reports it
  as `fights[].gameZone.id` (falling back to the report's `zone.id`), which is
  what a kill's `raidId` carries before the raid catalogue overwrites it. The
  collector therefore derives the zones to read from the kills it already found
  rather than spending a request discovering them.
- **A zone is asked only when the catalogue can place it after Mythic
  existed.** Mythic difficulty arrived with the Warlords pre-patch, so a zone
  from before it — Throne of Thunder, say — can never return Mythic rankings,
  and Warcraft Logs answers `difficulty: 5` there with `{ error: "Invalid
difficulty/size specified." }` rather than a payload. The discriminator is
  positive: the zone resolves to a catalogued raid whose content window reaches
  the Mythic era. "Returned an error once" is not a durable property of a zone
  (#351).
- **An error envelope is a refusal, not drift.** `{ error }` has no `rankings`
  array, so it used to be read as `parse_schema_drift` — and a troubled raid
  never goes terminal (#314), so the wasted request was re-paid on every run,
  forever. It now leaves the metric with no rankings and raises nothing.
- **A null `rankPercent` is ordinary.** A specialisation not ranked under a
  metric returns the encounter with no percentile. It must stay `unavailable`
  rather than being read as a zero parse.
- **The budget is split.** Zone requests take at most half of what remains once
  the shared canonical-identity request is reserved, newest tier first. One
  request covers a whole tier, so the tiers a reviewer is reading arrive
  immediately and deeper tiers land on later runs — without starving the
  per-fight hydration the first-kill row depends on.
- **Zone reads and fight hydration fail independently.** A zone the character
  cannot be ranked in must not cost the first-kill row its exact-fight parses,
  so a zone-rankings failure is recorded but does not stop report hydration.
- **Stored tier bests are carried forward.** One run reads only the newest few
  zones, so a publish that did not reach a zone keeps what is already stored
  rather than writing it back blank. A value already observed is never worsened
  by a later blank, exactly as for a fight's parse.
