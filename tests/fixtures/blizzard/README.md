# Blizzard gateway fixtures

Response fixtures for `packages/blizzard`. Each file is one response shape:
`status`, optional `headers`, and optional `body`. A fixture without a `body`
answers with an empty body.

No fixture here is a recording. Every one is **synthetic**: hand-built, and
limited to fields a source below shows Blizzard sending. A fixture never adds
a field; the variants only remove one, empty one, or change a value. Values
(names, ids, timestamps) are illustrative.

`packages/blizzard/src/fixtures.test.ts` fails if a fixture file has no row in
the table below, or a row names a file that does not exist.

## Sources

- **[#23]** — the fingerprint sweep prototype
  (`scripts/prototypes/fingerprint-sweep-measurement.ts`) ran against the live
  API on Railway `test` and read `guild.name` and `guild.realm.slug` from the
  character profile, `members[].character.name` and
  `members[].character.realm.slug` from the guild roster, and
  `achievements[].id` and `achievements[].completed_timestamp` from character
  achievements.
- **[#38]** — a live roster read recorded the member keys `faction`, `id`,
  `key`, `level`, `name`, `playable_class`, `playable_race` and `realm`, and
  `playable_class` keys `id` and `key` only: the roster carries no class
  name. Names come from `/data/wow/playable-class/index`.
- **[research]** — `docs/research/2026-09-12-blizzard-cutting-edge-achievements.md`
  observed achievement entries with `id`, `criteria`, and a millisecond
  `completed_timestamp`, including a completed entry whose
  `criteria.is_completed` was `false`.
- **[oauth]** — the client-credentials token response fields `access_token`
  and `expires_in` ([RFC 6749 §5.1](https://www.rfc-editor.org/rfc/rfc6749#section-5.1);
  Blizzard's
  [client credentials guide](https://community.developer.battle.net/documentation/guides/using-oauth/client-credentials-flow)).
- **[status]** — an HTTP status with no body. See the gaps below.

## Fixtures

| Fixture                                           | Provenance | Source       | Shape                                                      |
| ------------------------------------------------- | ---------- | ------------ | ---------------------------------------------------------- |
| `token-valid.json`                                | synthetic  | [oauth]      | A usable token                                             |
| `token-empty-access-token.json`                   | synthetic  | [oauth]      | `access_token` is an empty string                          |
| `token-forbidden.json`                            | synthetic  | [status]     | 403                                                        |
| `profile-guild.json`                              | synthetic  | [#23]        | A guilded character profile                                |
| `profile-guild-other-realm.json`                  | synthetic  | [#23]        | A guild on another realm from the character                |
| `profile-guild-empty-name.json`                   | synthetic  | [#23]        | `guild.name` is an empty string                            |
| `profile-guild-empty-realm-slug.json`             | synthetic  | [#23]        | `guild.realm.slug` is an empty string                      |
| `profile-without-guild.json`                      | synthetic  | [#23]        | No `guild` object                                          |
| `profile-forbidden.json`                          | synthetic  | [status]     | 403                                                        |
| `profile-missing.json`                            | synthetic  | [status]     | 404                                                        |
| `playable-class-index.json`                       | synthetic  | [#38]        | Class ids and names                                        |
| `playable-class-index-renamed.json`               | synthetic  | [#38]        | Class 8 under a different name, as after a patch           |
| `playable-class-index-empty-name.json`            | synthetic  | [#38]        | Class 8's `name` is an empty string                        |
| `playable-class-index-forbidden.json`             | synthetic  | [status]     | 403                                                        |
| `guild-roster.json`                               | synthetic  | [#23], [#38] | Two members, class ids only                                |
| `guild-roster-member-empty-name.json`             | synthetic  | [#23], [#38] | One member's `name` is an empty string                     |
| `guild-roster-member-empty-realm-slug.json`       | synthetic  | [#23], [#38] | One member's `realm.slug` is an empty string               |
| `guild-roster-member-without-playable-class.json` | synthetic  | [#23], [#38] | One member has no `playable_class` object                  |
| `guild-roster-without-members.json`               | synthetic  | [#23]        | No `members` array                                         |
| `guild-roster-forbidden.json`                     | synthetic  | [status]     | 403                                                        |
| `guild-roster-missing.json`                       | synthetic  | [status]     | 404                                                        |
| `achievements-completed.json`                     | synthetic  | [research]   | A completed entry whose `criteria.is_completed` is `false` |
| `achievements-empty.json`                         | synthetic  | [#23]        | An empty `achievements` array                              |
| `achievements-with-unfinished.json`               | synthetic  | [research]   | A completed entry and one with no `completed_timestamp`    |
| `achievements-non-numeric-pairs.json`             | synthetic  | [#23]        | Entries whose `id` or `completed_timestamp` is a string    |
| `achievements-malformed-timestamp.json`           | synthetic  | [research]   | One entry's `completed_timestamp` is not a number          |
| `achievements-without-achievements.json`          | synthetic  | [#23]        | No `achievements` array                                    |
| `achievements-forbidden.json`                     | synthetic  | [status]     | 403                                                        |
| `achievements-missing.json`                       | synthetic  | [status]     | 404                                                        |
| `achievements-rate-limited.json`                  | synthetic  | [status]     | 429 with `Retry-After: 60`                                 |
| `achievements-rate-limited-no-retry-after.json`   | synthetic  | [status]     | 429 without `Retry-After`                                  |

Tests also derive variants in code, named where they are built:

- invalid achievement ids and timestamps from `achievements-completed.json`;
- in `request-limiter.test.ts`, a 40-member roster made by renaming a
  `guild-roster.json` member, and 250 achievement entries carrying only the
  [#23] fields, a scale no fixture holds;
- a marker body substituted into an error fixture to prove the body never
  reaches a typed failure. Those markers are test inputs, not Blizzard shapes.

## Gaps

- **Error bodies.** No Blizzard error body has been recorded, so the 403, 404
  and 429 fixtures carry a status only. The client never reads a non-success
  body, so nothing depends on one.
- **403.** No 403 from Blizzard has been observed. The 403 fixtures pin how the
  client classifies one (currently `transient`) so that any change is
  deliberate.
- **`Retry-After`.** Whether Blizzard sends it on a 429 has not been observed.
  `achievements-rate-limited.json` carries it to exercise the client's handling
  of the standard header; `achievements-rate-limited-no-retry-after.json`
  covers its absence.
- **Absent `playable_class`.** Every member in the [#38] recording had one. The
  fixture without it removes a recorded field; it is not an observed shape.

[#23]: https://github.com/Erilla/SlashWho/pull/23
[#38]: https://github.com/Erilla/SlashWho/pull/38
