# Class-Coloured Dossier Character Names Design

**Issue:** [#97](https://github.com/Erilla/SlashWho/issues/97)

## Goal

Render every visible character-name mention in the applicant dossier with the corresponding World of Warcraft class colour, using known dossier character data as the single source of truth and a neutral fallback when that data is unavailable.

## Existing data and problem

Snapshot membership already stores each character's canonical identity, display name, and class. Character evidence is also stored against a canonical character identity. No database migration or additional persisted class field is required.

The dossier builder currently discards that identity when it emits boss-kill and Cutting Edge participant arrays as display-name strings. Display names are not unique across regions or realms. When two connected characters share a name, a web client cannot determine which class belongs to a participant mention even though the database and domain input contain the answer.

Connected-character rows already apply class colours through a private mapping. The dossier heading, Cutting Edge attribution, boss summaries, boss evidence details, and limitation attribution do not share that implementation.

## Domain and contract design

Raid-kill and Cutting Edge participant arrays will carry canonical `CharacterKey` values instead of display-name strings. The dossier builder will preserve the keys it already receives while grouping evidence and will retain its existing deterministic character ordering.

The dossier contract will parse these keyed participant arrays. This deliberately changes the applicant-dossier response contract rather than adding a parallel `characterKeys` field: two representations could drift, and display names are presentation rather than identity. Participant keys are invariantly a subset of the dossier's top-level `characters` collection.

No class field will be copied into participant evidence. The top-level dossier character remains the only source for display name and class.

## Shared rendering module

A shared dossier character-name module will own:

- canonical-key lookup against the dossier's top-level characters;
- class-name normalization and the complete supported-class-to-style mapping;
- display-name rendering;
- neutral rendering for an unresolved character, missing class, or unsupported class; and
- comma-separated rendering of participant lists without flattening names into one text node.

The dossier page will provide its known characters once. Callers will pass a full `DossierCharacter` when they already have one or a `CharacterKey` for evidence and attribution. This keeps future dossier views on the same seam and prevents name-based class inference.

If a key cannot be resolved, the renderer will show the key's name so evidence remains understandable. It will not guess a class from the name, role, guild, or surrounding evidence.

## Surfaces

The shared renderer will be used for:

- the applicant dossier heading;
- every Connected characters row;
- Cutting Edge character attribution;
- the first-kill boss summary;
- each expanded boss-kill participant list; and
- the affected-character mention in data limitations.

Guild names, raid and boss names, achievement names, labels, messages, and arbitrary upstream text will not receive class styling.

## Accessibility and responsive behavior

Character names and all surrounding context remain in the document; colour is supplementary and never replaces text, relationship labels, status labels, dates, ranks, or external-link names. The neutral fallback uses the normal foreground colour.

Class colour styles apply only to the shared name span. Hover and focus states preserve the class colour and add the existing underline/focus indication instead of replacing colour. The darkest conventional class colours will use brighter same-hue variants so normal-size text meets WCAG AA contrast against both dossier dark surfaces. Names remain unbroken next to status and external-link icons, while surrounding list punctuation can wrap naturally at narrow widths.

SlashWho currently ships a dark colour scheme only. The shared semantic style seam will keep future theme-specific colour adjustment local if a light theme is introduced.

## Testing

Tests will be added or updated in the following layers:

- Domain tests will prove that same-name characters on different canonical keys retain distinct identities in raid-kill and Cutting Edge participant arrays.
- Contract tests will prove that dossier participant arrays accept canonical character keys and reject the retired string representation.
- The shared renderer matrix will cover all thirteen supported classes plus missing, unsupported, and unresolved-character fallbacks.
- Dossier-level rendering tests will cover the heading, Connected characters, Cutting Edge attribution, boss summaries, boss evidence details, and limitation attribution with independently coloured same-name characters.
- Existing responsive browser coverage will verify narrow layouts and icon-adjacent rendering; the stale report-link label assertion introduced by the independently merged #99 behavior is outside #97 and will be reported separately.

Final verification will run formatting, lint, typecheck, the complete unit suite, the production build, and the relevant responsive browser tests.

## Compatibility and rollout

The applicant-dossier participant representation changes from display-name strings to `CharacterKey` objects. Domain and contract packages, the application dossier builder, the web application, and their fixtures/tests will land atomically in one change. No database migration, backfill, or persisted-data rollout is required because canonical identity and class are already stored.
