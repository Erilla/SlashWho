# Recorded provider payloads

Live Blizzard and Raider.IO responses, redacted, committed as test fixtures.
Unlike the hand-built fixtures in `tests/fixtures/raiderio/` (and
`tests/fixtures/blizzard/`, #597), these show what an upstream really sent.
They exist because hand-built fixtures certified guessed shapes: #38's roster
fixture asserted `playable_class.name`, a field Blizzard never sends (#39).

Everything here is local. No live traffic runs in the pull-request gate, and
a contributor without credentials runs the whole suite against these files.

## Layout

```text
recorded/
  <provider>/<endpoint>-<label>.json
```

Each file is one response in an envelope:

```json
{
  "provider": "raiderio",
  "endpoint": "raiderio.character",
  "recordedOn": "2026-09-26",
  "status": 200,
  "body": { "…": "…" },
  "ignored": ["characterDetails.character.gear", "…"]
}
```

`ignored` lists the root of every subtree the upstream sent that the
allow-list drops: field paths only, arrays folded to `[]`, and any key that is
not a plain identifier folded to `<key>`. It is the baseline the drift check
compares the fields we ignore against. Recordings made before it existed don't
have it; re-recording adds it.

There is no URL, header or target in the envelope. The label describes the
scenario (`claimed`, `declared-main`, `unknown-name`) and **never** the
character, guild or owner it was recorded from. Nothing but `README.md` and
recordings may live in this directory; the gate fails on anything else.

## What a recording may contain

`scripts/recorded-payloads.mts` holds an allow-list per endpoint. A recording
can hold a path only if the allow-list names it, and only in the form its kind
allows:

| Kind            | Recorded as                                                                  |
| --------------- | ---------------------------------------------------------------------------- |
| `identity`      | a placeholder from a closed list, or `""`/`null` as the upstream sent them   |
| `identity-path` | `/characters/<region>/<realm>/<character placeholder>`                       |
| `slug`          | a lower-case realm or region slug                                            |
| `enum`          | one of a closed set: class names, realm types, reviewed error codes/messages |
| `number`        | kept (levels, class ids, achievement ids, status codes)                      |
| `boolean`       | kept                                                                         |
| `timestamp`     | a synthetic whole-day sequence from 2020-01-01; the real value is never kept |
| `iso-timestamp` | the same synthetic whole-day sequence, as an ISO-8601 string                 |
| `opaque-id`     | a per-session sequence from `1`; one real id maps to one synthetic id        |

Stripped or replaced for every provider:

- **Character, guild and owner names** become placeholders (`Alfa`…`Zulu`,
  `Fixture Guild Alfa`…, `fixture-owner`…). One real value maps to one
  placeholder across a whole recording run, so an owner and that owner's
  profile list still agree. Case is kept: a name sent lower-case stays
  lower-case.
- **Discord handles** (`discord_profile`) become `fixture-discord-…`. An empty
  string stays `""` and a null stays `null`: that difference is what broke in
  #35, so it's shape, not identity.
- **Declared-main paths** keep their region and realm but have the name
  replaced.
- **Achievement timestamps** are synthesised. Real achievement ids paired with
  real completion times are the fingerprint that links alts, so they identify
  a person.
- **Everything the parsers don't read** is dropped: account ids, gear,
  scores, biographies, links, `_links`, media, customisations other than the
  two above, and a logged encounter's `log.sources`, which names the uploader's
  Raider.IO account. Character and logged-encounter ids the parsers do read
  are replaced with a small synthetic sequence.
- **Long arrays are cut**: roster members to 10, achievements to 25, a
  profile's characters to 10, a logged encounter's roster to 10.

BattleTags, raw request URLs, credentials, tokens and free text are never
recorded. No kind keeps them, and the verifier refuses any string that looks
like a URL, a BattleTag or an email address wherever it sits.

## How redaction is proven

Two checks, and neither trusts that redaction "was applied".

1. **The gate** (`scripts/recorded-payloads.test.mts`, in `test:unit`) reads
   every committed recording and fails on any path off the allow-list, any
   identity that is not a placeholder, `""` or `null`, any enum value outside
   its set, any timestamp that is not synthetic, and any URL-, BattleTag- or
   email-like string. It needs only the file, so it runs on every pull request.
2. **The recorder** refuses to write if any real identity it replaced, in any
   case, still appears anywhere in any file of the run. It then runs the gate's
   verifier on each recording before writing. One failure writes nothing.

An error `message` the allow-list hasn't reviewed stops the recording. An
unseen message is exactly the text that might echo a requested name back.

## Making or refreshing a recording

Recording is out-of-band, run by a maintainer, never in CI:

```bash
corepack pnpm exec tsx --env-file-if-exists=.env scripts/record-provider-payloads.mts raiderio character:claimed=eu/silvermoon/<name> view-characters:claimed=owner-of:eu/silvermoon/<name>
corepack pnpm exec tsx --env-file-if-exists=.env scripts/record-provider-payloads.mts blizzard guild-roster:root-guild=eu/argent-dawn/<name> character-achievements:root=eu/argent-dawn/<name> playable-class-index:eu=eu
```

It is deliberately not a `package.json` script: `pnpm run` echoes the whole
command line, real names included, before the recorder starts. `pnpm exec`
does not.

- Each target is `<endpoint>:<label>=<target>`. Raider.IO endpoints:
  `character`, `view-characters`. Blizzard endpoints: `character-profile`,
  `guild-roster` (addressed through a member, so the guild's name is never
  typed), `character-achievements`, `playable-class-index`.
- `view-characters:<label>=owner-of:<region>/<realm>/<name>` reads the owner
  from that character's profile, so nobody types or sees the owner's name.
- Blizzard needs `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET` in `.env`
  and spends one token request plus one request per target (two for a roster)
  from that client's hourly budget. Raider.IO's endpoints need no key.
- The recorder reads only what is present and skips the rest, as the #39
  prototype did. An absent field stays absent rather than failing the run.
- If it stops on an `unrecognised_value`, rerun with `--show-unrecognised`
  to see the value **on your terminal only**. Add it to the allow-list only if
  it carries no identity.

Review a refresh as a diff. The gate has already proved the redaction, so the
review is about meaning: which fields appeared, disappeared or changed kind,
and whether a parser needs to follow. A recording run on the same scenario
overwrites its file.

## How recordings relate to the hand-built fixtures

They sit alongside them. The gate also registers every hand-built file in
`tests/fixtures/raiderio/` and `tests/fixtures/blizzard/` as either:

- **upstream-shaped**: every `path: kind` it asserts (a field, a `null`, an
  empty string) must appear in some recording of the same endpoint and status
  class, or be listed in its `unobserved` register **with a source**; or
- **synthetic**: deliberately off-shape (schema drift), or an endpoint or
  status not yet recorded, with the reason.

The `unobserved` register must match exactly. A shape a new recording has
since shown must come off it, so the list of guesses can only shrink honestly.
A new hand-built fixture fails the gate until it is registered.

## Against the five faults in #39

| Fault                              | What catches it here                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| #38 `playable_class.name` invented | A roster fixture asserting it fails conformance: no recording shows it.                                                                    |
| #35 `discord_profile: ""`          | `""` survives redaction, so a recording of such a character shows it. The hand fixture lists it as unobserved, citing #35, until one does. |
| #36 403 `profile_is_private`       | Error bodies are recorded with their reviewed `errorCode`. The hand fixture cites #36 until a 403 is recorded.                             |
| #32 404 partway through a roster   | Not by itself: the recorder can pin a real Blizzard 404 body (none recorded yet), but the mid-sweep behaviour stays with #597's tests.     |
| #34 never-claimed characters       | Recorded `user: null` (`character-declared-main.json`) is an observed shape that the hand fixtures can no longer contradict.               |

Recording already found one: Raider.IO answers a character that doesn't
exist with **400** "Could not find requested character", not the 404 that
`raiderio/missing-character.json` assumed (`character-unknown-name.json`).
The client classifies it as transient; a test pins that until it's changed
deliberately.

## Drift check

`.github/workflows/provider-drift.yml` runs `scripts/provider-drift.mts` every
Monday, and on demand. It re-reads each configured target live, projects the
response through the same allow-list and redaction as a recording, and compares
it with the recording of the same `<endpoint>-<label>`. It is scheduled only;
it never runs in the pull-request gate.

| Change                                                                                     | Result                                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| The status differs from the recording's                                                    | fails, and opens or updates the `upstream-drift` issue |
| A value at an allow-listed path can't be classified (new type, enum value or message)      | fails, and opens or updates the issue                  |
| A `path: kind` no recording of the endpoint shows (a new `""` or `null`, a changed type)   | fails, and opens or updates the issue                  |
| A `path: kind` the probe's own recording shows is missing                                  | fails, and opens or updates the issue                  |
| An `ignored` root appears or disappears                                                    | warning in the job summary only                        |
| No recording for the endpoint or label, or no `ignored` baseline                           | warning; record the scenario                           |
| A 429, a 5xx or a failed request (after one retry), unless the recording holds that status | inconclusive: the run fails without filing an issue    |

The report carries endpoints, scenario labels, statuses, field paths and value
kinds. It never carries a value, a target or a request URL, and an unread
field name matching an identity the probe's redaction replaced is folded to
`<key>`.

A read-field failure can also mean the probe's own character changed: it left
its guild, or its owner removed a Discord handle. Then the fix is to re-record
that scenario, not to change a parser.

### Configuration

Repository secrets, not variables: targets name real characters, and the
repository is public, so they must be masked in the logs.

| Secret                                  | Holds                                                 |
| --------------------------------------- | ----------------------------------------------------- |
| `PROVIDER_DRIFT_RAIDERIO_TARGETS`       | whitespace-separated targets in the recorder's syntax |
| `PROVIDER_DRIFT_BLIZZARD_TARGETS`       | the same, for Blizzard                                |
| `PROVIDER_DRIFT_BLIZZARD_CLIENT_ID`     | a Battle.net client for the check                     |
| `PROVIDER_DRIFT_BLIZZARD_CLIENT_SECRET` | its secret                                            |

Each label must match a committed recording to be fully compared, so a target
is normally the same one its recording was made from. The intended set is a
claimed character and its owner's list, a character that doesn't exist, and a
private owner (#36) for Raider.IO; and a character's profile, achievements and
roster, the class index and a character that doesn't exist for Blizzard. With
no targets configured, the run fails as a configuration error.

### What a run spends

One request per target, two for `view-characters` addressed with `owner-of:`
and for `guild-roster`, plus one Blizzard token. With the set above that's
about 6 Raider.IO requests and 7 Blizzard requests a week, doubled at worst by
retries. No Warcraft Logs points. If the Blizzard client is shared with
production, its requests come out of `BLIZZARD_HOURLY_REQUEST_BUDGET`'s hour,
which they don't dent.

## Gaps

- No Blizzard recording yet: none has been made with real credentials. Until
  one is, the drift check can only catch a Blizzard value it cannot classify.
- No committed recording has an `ignored` baseline yet; each gains one when
  it is next re-recorded.
- Raider.IO: no 403 `profile_is_private`, no guildless character, no
  `discord_profile: null`, no 429 or 5xx, and the guild rankings endpoints are
  not recorded endpoints yet. The recorder and drift check do not yet fetch
  `raid-progress` or logged encounters; their recordings were redacted by hand
  into the recorder's exact form.
- The Blizzard token endpoint is deliberately not recordable: its body is a
  credential.

## Provenance

| File                                                                                                        | Recorded   | Notes                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raiderio/character-tournament.json`, `character-tournament-retail.json`, `view-characters-tournament.json` | 2026-09-14 | A tournament-realm profile, a retail member of the same owner, and the owner's list. Redacted by hand before this tooling existed, re-enveloped unchanged, and now verified by the gate. |
| `raiderio/character-claimed.json`, `view-characters-claimed.json`                                           | 2026-09-26 | A claimed character with a guild and a Discord handle, and its owner's list.                                                                                                             |
| `raiderio/character-declared-main.json`                                                                     | 2026-09-26 | An unclaimed character (`user: null`) declaring a main.                                                                                                                                  |
| `raiderio/character-unknown-name.json`                                                                      | 2026-09-26 | A character that does not exist: 400.                                                                                                                                                    |
| `raiderio/view-characters-unknown-owner.json`                                                               | 2026-09-26 | An owner that does not exist: 404 "Cannot find user".                                                                                                                                    |
| `raiderio/raid-progress-logged-first-kill.json`                                                             | 2026-09-28 | A kill list with one logged first kill and one kill with no logged encounter, from the #732 live checks. Redacted by hand into the recorder's form.                                      |
| `raiderio/logged-encounter-guild-kill.json`                                                                 | 2026-09-28 | A guild's Mythic kill with a visible roster, cut to five with the connected character first. Redacted by hand; `log.sources` dropped.                                                    |
| `raiderio/logged-encounter-no-guild.json`                                                                   | 2026-09-28 | A guild-less kill (`guild` and `guildPrivacy` null). Redacted by hand; roster cut to three and numeric fields illustrative.                                                              |
