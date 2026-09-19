---
name: pr-review
description: Review a pull request for correctness bugs in one pass and post the verdict as a single comment. Used by the claude-code-review workflow; takes an owner/repo/pull/N target.
allowed-tools: Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh pr comment:*), Read, Grep, Glob
---

# Review a pull request

Review the pull request given as the argument, for example
`Erilla/SlashWho/pull/317`, and post one comment with the verdict.

This runs on every pull request and is paid for per run, so it is written to be
cheap. Read what you need and stop. Do not explore the repository, do not open
files the diff does not touch, and do not re-read something you have already
read.

## 1. Decide whether to review at all

```bash
gh pr view <PR> --json isDraft,state,title,body,comments
```

Stop without commenting when the pull request is a draft, is not open, or
already has a comment from Claude. Say nothing and finish; a second opinion on
an already-reviewed pull request is money for nothing.

## 2. Read the change

```bash
gh pr diff <PR>
```

That diff is the subject of the review. Read the repository's root `CLAUDE.md`
once for the standards it sets.

Open a changed file only when the diff alone cannot answer a specific question
you already have — for example when a hunk calls something whose behaviour you
need to check. Opening files speculatively, to "get context", is the main way
this review gets expensive.

### When the change is large

On a pull request touching many files, do not try to give every file equal
attention and do not work through them in the order the diff happens to list
them. Pick the files where a defect would matter most — domain rules,
persistence, anything handling money, time, identity or concurrency — and
review those properly. Say at the end of the comment which parts you did not
cover.

**Post before you run out of room.** A partial review that reaches the pull
request is worth more than a thorough one that never does: the run is billed
either way, and a review nobody sees is the only outcome with no value at all.
If you are deep into a large change and unsure you can finish, post what you
have, name what is uncovered, and stop.

## 3. Find real problems, in one pass

Report only defects a reviewer would want fixed before merge:

- Logic that is wrong for some input: off-by-one, inverted condition, wrong
  operator, unhandled null or empty case, a wrong branch.
- Broken error handling: a failure swallowed, a partial result treated as
  complete, a retry that will loop forever.
- Concurrency and ordering: a race, a lost update, work that assumes an order
  the code does not guarantee.
- Data that escapes where it should not, or a violation of an invariant
  `CLAUDE.md` states.
- A change that contradicts what its own pull request says it does.

Do not report: formatting, naming, import order, test coverage, a preference
for a different structure, anything lint or typecheck already enforces, or a
pre-existing problem the diff did not introduce.

**The bar is confidence.** Report a finding only if you can point at the line
and say what input makes it go wrong. If the honest state is "this looks
suspicious", it does not meet the bar — leave it out. A review of five
maybes is worse than a review of one certainty, because the author stops
reading them.

Report at most five findings. If you have more, report the five that matter
most and say how many you left out.

## 4. Check each finding before posting it

Only for findings you intend to post, and only when you have not already read
the relevant code: confirm the defect against the file rather than the diff
hunk. The surrounding lines often answer it — a guard clause above the hunk, an
earlier assignment. Drop anything that does not survive.

Skip this step entirely when you found nothing. That is the common case and it
should be the cheapest.

## 5. Post one comment

```bash
gh pr comment <PR> --body "..."
```

Nothing found:

```markdown
## Code review

No issues found.
```

Findings, most serious first, each naming its file and line, what goes wrong,
and the input or state that triggers it:

```markdown
## Code review

**`packages/domain/src/tier.ts:42`** — `findTier` returns the first tier whose
start is after the kill, so a kill in the final tier falls through and returns
`undefined`. Any character whose most recent kill is in the current tier gets
no tier.

**`apps/worker/src/runtime.ts:88`** — the retry loop has no ceiling, so a
permanently failing character is retried forever.
```

Post exactly one comment. Do not approve, request changes, or post a review —
these findings are advisory and must not gate the merge.
