# SlashWho

SlashWho publishes World of Warcraft character-relationship information derived from public upstream data.

## Language

**Privacy-hidden ownership**:
The Raider.IO state indicating that a character's ownership link is intentionally not public. It is SlashWho's sole privacy signal for inferred relationships.
_Avoid_: Hidden alt, upstream opt-out

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
