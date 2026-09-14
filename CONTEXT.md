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
The reviewer-surface report about a searched character and every character linked to it, carrying evidence attributed per character. It is never stored, so it is always a view of the moment rather than a citable record.
_Avoid_: Intel report, applicant snapshot, saved dossier

**Fight parse**:
One Warcraft Logs percentile for damage, healing, or boss damage, attributed to one canonical character on one exact public Mythic fight. Its evidence must agree on report, fight, encounter, difficulty, region, and realm; available values link back to that supporting fight. Rankings use Warcraft Logs' historical comparison, not a current or character-wide lifetime comparison.
_Avoid_: Character parse, lifetime best, report parse

**First-kill parse**:
The fight parses summarized from the earliest displayed kill event for a boss. It is a summary of that event's supporting reports, not a claim about every historical kill.
_Avoid_: First-ever parse, initial character parse

**Best shown parse**:
The highest available fight parse for each displayed character and metric across the kill events currently shown for a boss. It retains the winning exact-fight link and never reaches into unrelated character history.
_Avoid_: Best parse, all-time best, character-wide best

**Source label**:
The record, per link, of whether a relationship was Raider.IO-declared or fingerprint-derived. It is retained on a snapshot and shown only on the reviewer surface; the public alt list still shows one undifferentiated list, and no confidence value is retained alongside it.
_Avoid_: Confidence, provenance score, match strength

**Manual connection**:
A durable, directional relationship explicitly added from one applicant dossier
to another discovered character. It is distinct from snapshot-discovered links
and is excluded when the target has an active removal request.
_Avoid_: Verified manual alt, ownership claim
