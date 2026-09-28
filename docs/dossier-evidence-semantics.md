# Applicant dossier evidence semantics

## Historic Mythic kill events

SlashWho groups Historic Mythic kill evidence by canonical raid, canonical
boss, region, and UTC calendar date. Guild attribution is not part of event
identity because separate Warcraft Logs uploads can disagree or omit it.

Each grouped event retains every distinct supporting report or fight URL and
all participating connected characters. When reports provide conflicting
non-null guilds, the dossier displays the lexicographically first normalized
guild name and realm so the result is independent of input order. If only one
report supplies a guild, that attribution is displayed. Historic world rank is
shown only when the selected guild's matching evidence supplies one consistent
rank; a rank from a differently attributed report is never lent to it.

This intentionally favors a simplified reviewer surface: distinct reclears of
the same boss in the same region on the same UTC date may appear as one event.
Evidence on different dates, for different bosses, or from different regions
remains separate.

## Raider.IO-logged first kills

A Raider.IO Mythic **first kill** is evidence when Raider.IO holds a logged
encounter of it (#732). A logged encounter is a parsed combat log, so it is
treated as one: the character counts as present only when the roster holds
their Raider.IO character id. Where the guild has hidden the roster, Raider.IO's
own attribution of that logged encounter to the character stands in for it.
Raider.IO's plain kill list, without a logged encounter, stays a place to
search Warcraft Logs and is never evidence on its own. Later kills, Heroic and
Normal are never read.

Warcraft Logs stays the source for everything it has. A Raider.IO first kill
within two hours (`STORED_KILL_MATCH_MS`) of a Warcraft Logs kill of the same
character and boss is that kill: the Warcraft Logs kill keeps its reports,
parses and guild, and gains the roster. An unmatched one becomes a kill of its
own, dated by the encounter's defeat, with the encounter's guild and no
reports or parses; if it is earlier than the character's Warcraft Logs kill it
becomes the boss's first kill. The same-region, same-date grouping above still
applies, so an unmatched Raider.IO kill on the night of a Warcraft Logs kill
shares that night's event. Its world rank comes from the encounter's guild and
exact defeat time, so a guild's first kill gets its rank and a later kill with
that guild gets none.

What is kept of a logged encounter is fixed: the kill's pull and defeat times,
duration and item levels, the raid and boss, the guild, whether the roster is
visible and until when the guild shares its raids (`shareRaidUntil`), deaths
and Vantus runes, and each raider's Raider.IO id, name, realm,
region, class, specialisation, role and item level. The uploaders
(`log.sources`, which can hold a BattleTag or Discord handle) and the raw
response are never kept. A logged encounter is stored once and shared; each
run publishes its first kills with the rest of its snapshot. The kill is kept
as first read; only the roster and the guild's privacy can change. A visible
roster is read again once the guild's `shareRaidUntil` has passed, or after 30
days where Raider.IO named no end, since a guild can hide its compositions
later: a re-read that finds it hidden (or a 403) makes it private and deletes
its raiders, and the dossier then shows "Roster unavailable" because the
guild hid it. A deleted log, a log of another kill or a failed read never
takes a visible roster away. A roster the guild hid is read again once a week
old, since a guild can open it later. A
permanent refusal (a deleted log, a 403, or a log of another kill) is stored
too, so it is not asked about again for 30 days, and the kill counts as having
no logged encounter meanwhile. A kill accepted while its roster was hidden was
never presence-checked; once a re-read shows the roster, it is checked like
any newly read kill. A kill already accepted stays accepted when its roster
becomes hidden.

A tier whose raids all closed before the character's kill-scan floor is
asked once per character, and again only once that read is about 90 days old
(each character's expiry is offset by up to two weeks so they don't fall due
together), or once a collection fix bumps its version. The ask costs one
Raider.IO request and no Warcraft Logs points: its kills are evidence only,
never a place to search. Between asks, the character's stored first kills in
such a tier are re-read from what was stored, under the same rules as above,
without asking for the kill list. Whether a kill's presence was checked is
recorded on the kill itself, so a kill accepted behind a hidden roster is
checked once the roster opens, however many runs that takes, and a partial
run cannot carry it past the check. A tier is marked as read only by a
complete run whose logged-encounter reads fell short of nothing.

A raider removed from SlashWho (`suppressed_characters`) is left off every
roster a dossier shows, while the player and role counts stay Raider.IO's. The
stored rows are kept; removal suppresses reads, as it does everywhere else.

States stay distinct:

- Reports and parses a kill has no public log for are shown as "No public logs
  found". That is display text for an empty list, never numeric zero.
- A roster that cannot be shown is "Roster unavailable", with the reason: the
  guild hid it, Raider.IO has no logged encounter of the kill, or it has not
  been read yet. It is never an empty table and never "not present".
- A raider whose item level Raider.IO did not give shows "—", never 0.
- A kill with no guild (a pug) shows "—", as elsewhere.

A failed or capped logged-encounter read makes the run partial, so it never
removes a stored kill. A read that throws or is rate limited stops the phase:
no further read is sent that run; a run that could not read the kill list at all carries
every stored Raider.IO first kill forward unchanged. No shortfall of any code
— a capped backlog (`request_cap`), a rate limit (`rate_limited`) or a failed
read (`unavailable`) — schedules a whole-run retry of its own: a retry would
spend Warcraft Logs points just to read Raider.IO again, so the backlog is
left to drain through the character's next ordinary run, 50 at a time. A run
partial only for its Raider.IO reads still supports "No qualifying public
logs found", because its Warcraft Logs history scan ran; a run whose scan was
skipped never does.
