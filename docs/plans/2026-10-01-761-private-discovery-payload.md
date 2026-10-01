# Plan for #761: keep private upstream identity out of queue storage

## Outcome

Discovery jobs must never store the normalised Raider.IO root, its owner id,
or its Discord profile guess. Existing jobs remain runnable. Claimed-character
traversal and profile-guess resolution continue using ephemeral upstream reads.

## Implementation

1. Remove `rootCharacter` from `DiscoverCharacterJob` and from the search and
   applicant-collection enqueues. Keep their upstream admission checks and
   existing failure/cancellation behaviour.
2. Construct discovery payloads at `createDiscoveryQueue.enqueue` using only
   `runId`, a freshly constructed `key` (`region`, `realm`, `name`), and present
   `correlationId`, `enqueuedAt`, and `continuation` fields. No object spreads
   from caller data or nested character keys.
3. Construct evidence payloads using only `runId` and present `correlationId`,
   `enqueuedAt`, and `mode`. Fingerprint admission already stores only `runId`;
   retain that shape. Scheduled maintenance/resume payloads remain empty.
4. Remove the discovery handler's use of `job.rootCharacter`. Older JSON jobs
   may contain it, but the handler ignores it and reads the root through the
   existing scoped Raider.IO gateway. Continuations retain their existing
   behaviour and skip Raider.IO discovery.
5. Leave the domain discovery API's optional in-memory root optimisation in
   place: the storage boundary and worker shortcut are this issue's scope.

## Tests and verification

- Test first with exact payload assertions at both admission call sites,
  including upstream roots populated with private fields.
- Assert exact pg-boss send payloads for ordinary discovery, continuation,
  fingerprint admission, and evidence. Supply structurally wider inputs,
  including private fields in the key and evidence metadata, to prove the
  queue strips them at runtime rather than relying on TypeScript.
- Exercise an old job containing a stale root with private fields. Assert a
  fresh root read, successful completion, and relationships derived from the
  fresh upstream result. Cover claimed traversal and profile-guess resolution.
- Update existing tests which expect the admitted root to avoid a worker read.
- Run the full repository gate, self-review against `origin/main`, merge the
  latest `origin/main`, and re-run the full gate before making the PR ready.

## Operational decision

No migration or database scrub is included. The maintainer's decision about
existing rows on Railway test is pending. Do not write to that database unless
the maintainer explicitly authorises it; record the decision before closing
the issue. Never print stored private values.

## Manager review requested

Confirm the field-by-field boundaries (including nested keys), retention of
admission reads, legacy-job compatibility, and leaving the domain's in-memory
optimisation intact. The expected cost is one extra Raider.IO root read for
jobs previously carrying an admitted root; continuations remain unchanged.
