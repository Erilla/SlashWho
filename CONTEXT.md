# SlashWho

SlashWho publishes World of Warcraft character-relationship information derived from public upstream data.

## Language

**Privacy-hidden ownership**:
The Raider.IO state in which a character carries no public ownership link. SlashWho records it as a snapshot limitation reason; it does **not** exclude the character from inferred relationships, because the state cannot be told apart from a character never claimed on Raider.IO. A manual removal request is the only exclusion route.
_Avoid_: Hidden alt, upstream opt-out, privacy signal

**Fingerprint-derived link**:
A relationship between characters inferred from Blizzard achievement-completion data, rather than declared by Raider.IO.
_Avoid_: Verified link, confirmed alt

**Alt list**:
The public list of characters linked to a root character. It intentionally does not distinguish Raider.IO-declared relationships from fingerprint-derived links.
_Avoid_: Verified-alt list, inferred-alt list

**Partial snapshot**:
An immutable historical result known not to contain every discoverable relationship. It is public as partial while its limitation reason remains internal.
_Avoid_: Failed snapshot, incomplete refresh

**Ephemeral fingerprint**:
Achievement-completion data held only while a single discovery sweep is running. It is discarded before snapshot publication and never becomes a stored signature.
_Avoid_: Fingerprint cache, stored signature

**Reviewer surface**:
The gated view of SlashWho's findings intended for someone assessing an applicant. It may expose material the public view withholds, but it takes the same input as a public search: a single character.
_Avoid_: Officer mode, admin view, Applicant Intel API

**Applicant dossier**:
The reviewer-surface report about a searched character and every character linked to it, carrying evidence attributed per character. It is assembled on request and never stored, so it is always a view of the moment rather than a citable record.
_Avoid_: Intel report, applicant snapshot, saved dossier

**Source label**:
The record, per link, of whether a relationship was Raider.IO-declared or fingerprint-derived. It is retained on a snapshot and shown only on the reviewer surface; the public alt list still shows one undifferentiated list, and no confidence value is retained alongside it.
_Avoid_: Confidence, provenance score, match strength
