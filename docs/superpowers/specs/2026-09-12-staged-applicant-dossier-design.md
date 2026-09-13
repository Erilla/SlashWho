# Staged Applicant Dossier Design

**Date:** 2026-09-12

## Problem

A cold applicant lookup waits for the durable linked-character discovery run
before showing any dossier evidence. A real Railway run consumed its 300
Blizzard fingerprint requests over roughly two and a half minutes. The result
was a partial one-character snapshot, while the browser showed only a generic
researching message.

Increasing the fingerprint request cap makes that wait longer and still cannot
turn bounded provider work into a guarantee of exhaustive public data.

## Decision

Render a source-bound, transient **initial dossier** for the submitted
character immediately, while the existing durable discovery run continues in
the background. Replace it with the linked-character dossier when the run has
published a snapshot.

The user interface distinguishes these states:

| State      | Evidence scope                                 | Required disclosure                                                                |
| ---------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `initial`  | Submitted character only                       | Linked-character research is still running; this is not the full applicant record. |
| `complete` | Every character in a complete current snapshot | Full linked-character research completed.                                          |
| `partial`  | Every character in a partial current snapshot  | Additional linked characters may exist; the displayed dossier is not exhaustive.   |

`complete` describes the discovery snapshot, not universal proof that every
external log exists. All source-specific Warcraft Logs limitations continue to
be displayed per character.

## Data flow

```text
Applicant URL
    |-- parse canonical character --> initial Warcraft Logs evidence --> initial dossier
    |
    `-- start/reuse durable discovery run --> current relationship snapshot
                                                |
                                                `--> expanded dossier
```

The initial route does not wait for a snapshot and does not persist a dossier,
evidence, or raw provider payload. It builds its root-only dossier using the
same aggregation and limitation rules as the expanded dossier.
Its character is labelled `submitted`, because no relationship source has yet
been established. Snapshot-backed source labels retain their existing mapping.

The established `discovery_runs`, queue, fingerprint admission, snapshots, and
source labels remain the sole durable representation of linked characters. No
new relationship or evidence tables are introduced.

## HTTP and client behaviour

- Starting research starts or reuses the existing discovery run.
- The client requests initial evidence as soon as it has a canonical identity,
  including when the discovery job is still queued or running.
- The dossier response carries explicit research state and a human-readable
  disclosure. It is not inferred from the presence or absence of raids.
- The client preserves visible initial evidence while polling the job URL.
- On a completed job, the client requests the expanded dossier and replaces the
  initial dossier. A partial snapshot produces `partial`, never `complete`.
- On a failed job, the client keeps initial evidence and shows research failure
  separately, replacing the running disclosure with a failed, root-only
  disclosure even if initial evidence arrives afterward. Refreshing a job URL
  resumes the same job status/research view.
- Successful expansion clears initial-read errors and ignores late initial
  responses, including failures.

## Safeguards

- Initial evidence uses a separate, configured Warcraft Logs timeout and
  request cap. It cannot inherit the unbounded linked-character discovery wait.
- Initial evidence never supports a negative claim about other applicant
  characters or a full Cutting Edge conclusion.
- Existing public-read and anonymous search limits continue to protect both
  initial reads and status polling.
- No credential, raw provider payload, or unbounded provider error is exposed
  to the browser.

## Testing and rollout

- Unit tests cover root-only evidence, research-state serialization, partial
  disclosure, and preservation of initial evidence on job failure.
- Route tests cover initial reads while a job is active and expanded reads after
  a complete or partial snapshot.
- Browser tests cover immediate initial rendering, polling replacement,
  refresh/resume, failed research, and accessible disclosure.
- Run the full local suite and deploy to Railway `test`; exercise a real cold
  lookup and confirm an initial result appears promptly before any production
  promotion.
