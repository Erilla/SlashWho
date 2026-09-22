# Historical raid-guild fingerprint traversal

## Goal

Let a dossier revisit find new fingerprint-derived connected characters through
the public historical raid guilds of characters already in its current
snapshot. A discovered character is always compared directly with the dossier
root using the existing fingerprint floors; a historical guild only selects
candidates and never becomes a published relationship.

## Trigger

Reading an existing dossier asks the discovery service to schedule a connected
character refresh. The request is non-blocking and serves the current snapshot
unchanged. The database coalesces concurrent visits and applies the existing
fingerprint cadence and shared hourly admission budget, so repeated reads do
not multiply upstream work.

The scheduled run performs normal current-character discovery and then its
fingerprint sweep. A fresh snapshot can therefore be revisited to find newly
added guild members without waiting for snapshot freshness to expire.

## Eligible historical guild observations

The sweep reads only completed, persisted Warcraft Logs evidence for characters
in the current snapshot. An eligible observation is a public Mythic kill with a
non-null report guild containing a name, supported region, and realm. The
guild region is persisted with the kill; existing records that predate the
field are ignored rather than inferred from a character or root.

Evidence may be partial or old: it is a true historical observation, while
incompleteness only means that more sources may become available later. No
Warcraft Logs request, credential, raw report, or hidden ownership signal is
used by the fingerprint sweep. Historical guild identities are neither exposed
on the dossier nor logged.

## Bounded traversal

One run starts with the root's current Blizzard guild roster plus every
deduplicated eligible historical guild from the starting snapshot. Historical
guild identities are ordered by their newest observation, then by canonical
guild identity. Every roster member is coalesced by canonical character id,
ordered deterministically, restricted to the root region, and compared directly
with the root fingerprint. Suppression is checked before a fingerprint request
and immediately before admission.

The traversal has one historical-guild hop. Matches discovered from a historical
roster are output only; their own history is not added to the current plan. A
later visit may use their completed evidence as an input source. This reaches
Ictinus -> Boptinus -> Mistakinus while preventing an unbounded guild graph.

Every Blizzard request, including direct historical-guild rosters, consumes the
existing fingerprint reservation and hourly budget. A missing or disbanded
historical guild is an empty source after its 404 request; it is not an upstream
failure. Transient and structural failures keep the current retry semantics.

## Continuation

The first capped cycle persists its ordered historical-guild plan, source
position, and candidate cursor with the existing snapshot-owning continuation
state. Continuations reuse that frozen plan, resume strictly after the recorded
candidate, and do not add sources from newly amended snapshot members. They
therefore eventually cover every guild that was eligible at the visit, without
quietly increasing traversal depth. Existing request accounting, ownership
checks, atomic snapshot amendments, and the consecutive non-progress bound
remain in force.

## Evidence collection

This feature queues no *additional* evidence work merely because a known
character is considered; the dossier's existing evidence-refresh behaviour is
unchanged. After a fingerprint candidate is newly admitted to the snapshot, the
worker additionally reserves and queues one full evidence collection for that
specific character. Its resulting public Mythic-kill guild observations become
eligible on a later visit; existing collection coalescing prevents duplicates.

## Verification

Unit and integration coverage will prove:

- a fresh dossier visit schedules a coalesced due connected-character sweep;
- all eligible historical guilds are planned and resume across budget-capped
  cycles;
- Ictinus -> Boptinus -> Mistakinus admits Mistakinus only after its normal
  fingerprint comparison passes;
- duplicate guilds and characters are fetched/compared once, suppression is
  preserved, and stale guild 404s are non-fatal;
- legacy evidence with no guild region is ignored; and
- only a newly admitted character queues a full evidence collection.
