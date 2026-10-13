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
The list of characters linked to a root character in its snapshot. It is no longer presented publicly: the applicant dossier lists the same characters, each with its source label.
_Avoid_: Verified-alt list, inferred-alt list

**Partial snapshot**:
An immutable historical result known not to contain every discoverable relationship. It is shown as partial; only a privacy-hidden limitation is explained to the reader, and other limitation reasons remain internal.
_Avoid_: Failed snapshot, incomplete refresh

**Ephemeral fingerprint**:
Achievement-completion data held only while a single discovery sweep is running. It is discarded before snapshot publication and never becomes a stored signature.
_Avoid_: Fingerprint cache, stored signature

**Reviewer surface**:
The unlisted view of SlashWho's findings intended for someone assessing an applicant. There is no longer a separate public view; it takes a single character as input, and needs no account.
_Avoid_: Officer mode, admin view, Applicant Intel API

**Applicant dossier**:
The reviewer-surface report about an opened character and its page members, carrying evidence attributed per character. Every member reuses its group's discovery, while the URL and root stay the opened character's. It is never stored, so it is always a view of the moment rather than a citable record.
_Avoid_: Intel report, applicant snapshot, saved dossier

**Connection**:
An observation of a link between two characters, with its observer, source and time. Manual connections are read live. Rejections are recorded separately from connection observations.

**Group**:
The stored connected component of counting links. Groups share discovery and reviewer exclusions. Membership recomputes best effort after publication; it does not participate in the publication transaction.

**A page's members**:
The characters reachable from the opened character through counting links within its stored group, without showing or traversing suppressed characters, plus non-suppressed members of its own latest completed snapshot. The snapshot fold-in preserves immediate visibility while recompute catches up. Freshness, active discovery, research state and weekly sweep eligibility use page members, rather than the whole stored group.

**Historic alias**:
A reviewer-declared former name and realm attached to one connected character. It is used to collect older evidence under that character and is not an independent dossier character.

**Fight parse**:
One Warcraft Logs percentile for damage, healing, or boss damage, attributed to one canonical character on one exact public Mythic fight. Its evidence must agree on report, fight, encounter, difficulty, region, and realm; available values link back to that supporting fight. Rankings use Warcraft Logs' historical comparison, not a current or character-wide lifetime comparison.
_Avoid_: Character parse, lifetime best, report parse

**First-kill parse**:
The fight parses summarized from the earliest displayed kill event for a boss. It is a summary of that event's supporting reports, not a claim about every historical kill.
_Avoid_: First-ever parse, initial character parse

**Best parse**:
The highest Mythic percentile a displayed character holds for a boss and metric, read from the whole raid zone rather than from the kill events shown beneath it. It may therefore come from a kill the dossier withholds, so it links to that character's own rankings rather than to a fight, and it is never written onto a first-kill parse. A character with no displayed kill on a boss gets no row; where zone rankings have not been read, the best of the displayed events stands in.
_Avoid_: Best shown parse, lifetime best, first-kill parse

**Source label**:
The record, per link, of whether a relationship was Raider.IO-declared or fingerprint-derived. It is retained on a snapshot and shown on the reviewer surface, which also labels manually added characters; no confidence value is retained alongside it.
_Avoid_: Confidence, provenance score, match strength

**Known reverse declaration**:
A character from another root's latest completed snapshot where the current root
was the first `declared_main` member. Only that first member is the root's direct
declaration; later members are mains reached by following the forward chain.
Discovery treats the stored direct edge with the same authority as a forward
Raider.IO declaration and adds the declaring character without another upstream
request. Discovery's lookup remains one hop; dossier membership follows transitive counting links through the group. A newer observation can retire a link, and canonical deduplication contains self-references and cycles.
_Avoid_: Historical reverse match, reverse account enumeration

**Manual connection**:
A durable, directional relationship explicitly added from one applicant dossier
to a character key. A manual connection can also come from an application: the applicant sheet watcher links the other characters in a response to its first one, and the dossier labels these "From application". That is still the applicant's statement, not an ownership claim. It is recorded before that character has been discovered,
so it may name a character SlashWho holds nothing about yet; until discovery
creates it the connection is **pending** and carries no class or level rather
than an invented one. Adding it starts a discovery run rooted at that
character, so its own Raider.IO alts and Blizzard guild-roster fingerprint
matches join the dossier as well. It is distinct from snapshot-discovered links
and is excluded when the target has an active removal request.
_Avoid_: Verified manual alt, ownership claim, manual alt list

**Excluded connection**:
A connected character, manual or snapshot-discovered, that a reviewer has hidden
from one dossier's evidence. The searched character cannot be excluded. The
character keeps its row, greyed and labelled, so the exclusion can be
reversed; it contributes no kills, wipes, parses or Cutting Edge, raises no
limitation, and never costs another character its place under the character
ceiling. Its effect is shared by the maker's group, and excluding a manual
connection does not disturb the characters that connection's own discovery run
found. It is shared by every viewer, unlike the per-viewer visibility filter.
Reads ignore suppressed makers' rows and maker self-exclusions, including recorded Warcraft Logs aliases. Include and Remove clear the stored group's rows, suppressed makers included; Exclude and manual adds act from the opened page.
_Avoid_: Removal request, suppression, blacklisted alt

**Terminal tier**:
A raid tier whose evidence for one character is stored indefinitely and never
re-queried. A tier becomes terminal only when its current-content window has
closed, the run that read it reported no limitation for it, and every kill in
it has settled. A raid with no catalogued window is never terminal. It is
recorded per collection domain, so a fix to one kind of evidence re-collects
that kind alone. The percentiles it freezes are treated as final by policy,
not because a ranking cannot move.
_Avoid_: Archived tier, frozen evidence, cached tier

**Settled kill**:
A kill old enough that its rankings are taken to have stopped moving, meaning
older than `EVIDENCE_KILL_SETTLE_DAYS`. Until then the fight is re-read on
every run and its tier cannot go terminal. The threshold is an admitted guess
rather than a measured property of the upstream.
_Avoid_: Final parse, confirmed percentile

**Rebuild**:
Forgetting every terminal mark for one character so its history is collected
again. It is a flag rather than an action: it marks work as outstanding and
lets the ordinary run, retry and budget machinery drain it across many hourly
windows. It deletes no stored evidence, and it is never reachable from the
reader-facing refresh control.
_Avoid_: Full refresh, hard refresh, re-scan
