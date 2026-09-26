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
  "body": { "…": "…" }
}
```

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
- **Everything the parsers don't read** is dropped: character and account ids,
  gear, scores, biographies, links, `_links`, media, customisations other than
  the two above.
- **Long arrays are cut**: roster members to 10, achievements to 25, a
  profile's characters to 10.

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

## Gaps

- No Blizzard recording yet: none has been made with real credentials.
- Raider.IO: no 403 `profile_is_private`, no guildless character, no
  `discord_profile: null`, no 429 or 5xx, and `raid-progress` and the guild
  rankings endpoints are not recorded endpoints yet.
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
