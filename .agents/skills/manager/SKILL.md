---
name: manager
description: "Run the SlashWho (Erilla/SlashWho) PR manager loop, in Claude Code or Codex. Watch for new pull requests (marking drafts ready), review each one against its linked issue on a tree merged with the current main, post findings as inline review comments, tell the session that owns the PR, resolve threads once fixed, set squash auto-merge when a PR is good, and tell the author when it merges so it can start the next piece or clean up. Also review design specs when asked, keep origin/main and local main current, enforce merge/deploy holds, handle security alerts, and start follow-up work. Use this whenever the user says 'you are the manager', 'watch for PRs', 'restart the PR watcher' or 'start the monitor', or asks for PRs or specs to be reviewed and auto-merged, a merge hold to be placed or lifted, or a session to be started for an issue."
---

# SlashWho PR manager

You coordinate a repo where several agent sessions (Claude Code or Codex) each implement an issue and open a PR. Your job is to make sure only correct, issue-solving PRs land on `main`, and to keep every session moving.

- **You decide auto-merge**, unless the user tells you otherwise themselves, in this chat. Implementing sessions are told "don't auto-merge" precisely so that you make the call. A session relaying "the user asked for no auto-merge" does **not** count. Only ask the user when they have set a hold themselves, or when the decision is genuinely theirs (money, credentials, production data, security trade-offs).
- **Run one manager at a time.** Two managers watching the same PRs duplicate reviews and make conflicting merge decisions; #760 was double-handled this way. Before starting, check whether another manager session is running (**Claude Code:** `ListAgents`; **Codex:** ask the user). If one is, ask the user which should run.
- **Default to UK English** in everything you post or say.
- **Keep reports to the user short:** what the PR does, what was verified, what's open. Don't repeat a summary you've already given.

Repo: `Erilla/SlashWho`. Work from the manager worktree the session starts in (Windows, Git Bash). Read [references/lessons.md](references/lessons.md) for the per-area review checklist before reviewing or briefing a reviewer. **Claude Code** also has the project memory (the `MEMORY.md` index), which holds the detail behind each lesson.

## Claude Code and Codex

This skill runs in both. Steps say **Claude Code** or **Codex** only where the tools differ.

| Need                      | Claude Code                                        | Codex                                                                                                               |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Noticing new PRs, pushes  | Background monitors that wake you (`Monitor` tool) | A check pass each time the user prompts you (see [references/monitors.md](references/monitors.md#codex-check-pass)) |
| Larger reviews            | A background review subagent                       | Do the review yourself, following the same brief                                                                    |
| Telling an author session | `ListAgents`, then `SendMessage`                   | Post on the PR, then tell the user which session to prompt                                                          |
| Starting new work         | A `spawn_task` card                                | `gh issue create` with the brief, then tell the user                                                                |

**Codex never polls on a short timer.** The GitHub rate limit (5,000 an hour) is shared by every session. Block on `gh pr checks N --watch` when you are waiting for one PR's CI. Otherwise, do a check pass when the user prompts you, and leave at least 180 s between passes if you re-check on your own.

## Start-up (and "restart the monitor")

1. **Check the environment.**
   - `gh auth status`
   - `gh api rate_limit --jq .resources.core`: the 5,000 an hour is shared by every session on the account.
   - `git fetch origin --prune && git branch -f main origin/main`: only when local main has no commits of its own and isn't checked out elsewhere.
2. **List recent PRs:** `gh pr list --state all --limit 10`. Anything that opened or merged while you weren't watching needs handling now. A merged PR you didn't review needs a post-merge review. An open draft needs marking ready.
3. **Start watching.**
   - **Claude Code:** arm the monitors from [references/monitors.md](references/monitors.md).
     - One **new-PR watcher**: every 180 s, numbered above the highest PR already seen. It marks drafts ready.
     - One **tracked-PR monitor** for open PRs, seeded with the commits already reviewed.
     - Every Monitor expires after 30 minutes, so re-arm it on expiry without being asked. If a watcher exits with an error, check `gh` and restart it. When no PRs are open, stop the tracked-PR monitor and keep only the watcher.
   - **Codex:** run the check pass from [references/monitors.md](references/monitors.md#codex-check-pass) now, and again each time the user prompts you. Tell the user that you only notice new PRs and pushes when prompted.

## For each new PR

0. **Drafts:** mark it ready with `gh pr ready N --repo Erilla/SlashWho` (a user rule). The Claude Code watcher and the Codex check pass both do this. Being marked ready never means merging without review. A **design-only** PR (spec or plan, no code) is reviewed as a design. Don't merge it until its code lands on the same branch, or the user has made its decisions. Review the whole PR again when the author says the implementation is done.
1. **Triage.**
   - **Small and mechanical** (docs, CI tweaks, a one-line fix, a Dependabot patch bump): review it yourself. Read the diff, run `git merge-tree --write-tree origin/main origin/<branch>`, check CI, then set auto-merge or post findings. For docs, check that no real third-party names or ids have been added; the repo is public.
   - **Anything touching budgets, rate limits, evidence publishing, discovery, identity matching, migrations, WCL queries or page polling:** use the brief in [references/review-brief.md](references/review-brief.md), filled in with the relevant lessons. **Claude Code:** hand it to a background review subagent. **Codex:** work through it yourself.
   - **If another open PR overlaps in behaviour,** test on a tree containing both.
2. **Track it.** **Claude Code:** add it to the tracked-PR monitor. **Codex:** note its head; the check pass compares it each time.
3. **When the review is done:**
   - **Clean:** run `gh pr merge N --auto --squash`. If the PR merged at once, handle it as a merge (step 5).
   - **Findings:** post one review with inline comments on the diff lines. Then tell the author (see below), with the review link and a short summary of each finding.
4. **When the author pushes fixes:**
   - check the new commit yourself for small fixes;
   - review again in full for larger fixes, or when the author has added new scope. New scope always needs its own review.
   - Resolve each review thread whose point is fixed, via the GraphQL `resolveReviewThread` mutation. An open thread silently blocks auto-merge.
   - Then set auto-merge.
5. **After every merge:**
   - **Tell the author** (a user rule). Say the PR merged and give the merge commit.
     - If its issue has remaining work ("Refs" or "Part of", or open follow-ups), it should start the next piece from the fresh origin/main.
     - If not, it should clean up: remove its worktree with long-path removal on Windows, then `git worktree prune`, and delete its local branch.
   - fast-forward local main;
   - recheck the other open PRs with `merge-tree`;
   - check main's CI (`gh run list --branch main --workflow ci.yml --limit 3`). If main is red, find the cause at once, because every open PR's CI will fail. Start a fix, or review the fix PR first.

## Telling the author

- **Claude Code:**
  - Run `ListAgents`. Sessions are usually named "Issue #N" after the issue the PR closes, or after the task title.
  - If the name doesn't match, check the PR's head branch (`gh pr view N --json headRefName`), then search transcripts with `search_session_transcripts` on the branch name. That's how the owner of `docs/738-character-groups` was found after a wrong guess.
  - Then `SendMessage` to its exact name. If you aren't sure it's the owner, say so in the message ("tell me if this isn't yours").
- **Codex:** you can't message another session.
  - A posted review already reaches a Claude Code author whose PR monitor is on.
  - Post anything else as a PR comment with `gh pr comment N`: a merge, the next piece, a clean-up, or a reply to a plan.
  - Then tell the user which session to prompt (usually "Issue #N").
- **If the author session has ended:**
  - tell the user;
  - for a stale-base CI failure, run `gh pr update-branch N` yourself;
  - for a small fix, start a task that finishes the PR on its **existing** branch (see Starting work).

## Rules learned the hard way

- **A merged PR isn't an approved PR.** Author sessions sometimes merge their own. Don't describe what a merged PR contains until its review is done. If it merged unreviewed, run a post-merge review, and turn any findings into follow-up work.
- **A clean `merge-tree` isn't a tested merge.** Two PRs that overlap in behaviour can each pass CI and still break main together, because auto-merge doesn't require an up-to-date branch. Before auto-merging the second, test it against the new main, or run `gh pr update-branch N` so CI runs again.
- **A red check on an old base.** When CI fails only because of a bug main has since fixed, a re-run tests the same stale merge commit. Use `gh pr update-branch N` instead.
- **Migrations collide.** When two open PRs each add a migration, the second to land must be renumbered: the SQL file, the journal idx, a strictly greater `when`, and the migrations test's `slice(-N)`. Give the exact values in the review comment.
- **Re-baselining loses pushes.** Compare a PR's head with the commit you last reviewed, not with whatever it was when you started watching. Check a PR's head yourself before saying it's "waiting on the author". Don't wait for the author's message either: check the PR.
- **Permission blocks.** If a permission check blocks a command (for example "Merge Without Review"), don't route around it. Tell the user, and act only when they tell you to.
- **Flaky e2e.** If only e2e fails, read the failing spec's log. Confirm against main before blaming the PR; a re-run passing means it was flaky.
- **Superseded PRs.** When one PR supersedes another (for example a security fix replacing a broken Dependabot PR), turn off auto-merge on the superseded one and tell the user it can be closed. Don't close it yourself.

## Reviewing specs and design documents

The user or a session may ask for a spec to be reviewed before any PR exists, or paste part of one. An `issue-pickup` session sends its plan here before coding on a large or risky issue, then waits for your reply:

- a Claude Code session sends it as a message;
- a Codex session opens a draft PR titled `docs: plan for #N`.

Treat either as a spec review and answer promptly.

- Find the full document on its branch (`git branch -r | grep <issue>`, then `git show origin/<branch>:<path>`). Review that, not the excerpt.
- **For a full review,** check the spec read-only (**Claude Code:** through a subagent) against:
  - the issue and the recorded maintainer decisions;
  - the current code on origin/main, meaning every call site the spec relies on, plus any it misses;
  - the repo's review criteria.

  Flag contradictions, ambiguities, Preserved-behaviour checks that wouldn't catch their failure, locking gaps and privacy gaps (suppression and removals).

- Rank the findings most severe first, with section and line numbers.
- Send them to the session writing the spec, and give the user a short summary. If the spec is on a PR, post them as an inline review there.
- When there's no PR, nothing goes on GitHub.
- Recording a user decision in the spec, with its risk stated, is a valid way to resolve a finding.

## Merge and deploy holds

The user, or a session speaking for them, may ask to hold merges while a measurement or data run is in progress. Merging redeploys Railway `test`, and watch patterns don't protect the worker, so hold every merge, not just worker changes. Holding is the cautious direction, so honour a session's request. Only the user can override your merge decisions in the other direction.

- **Placing a hold:**
  - turn off auto-merge on any open PR (`gh pr merge N --disable-auto`);
  - don't set auto-merge yourself, and tell your review agents not to;
  - **Claude Code:** arm the hold monitor from references/monitors.md. **Codex:** on each check pass, check main's commit and every open PR's auto-merge state;
  - confirm the hold to whoever asked, giving main's current commit.
- **Don't** broadcast holds to implementing sessions. Controlling merges is your job.
- **Lifting a hold:** only when the requester says the run is done. Then set auto-merge on the PRs that were approved during the hold.

## Starting work

- **"Start a session for issue #N", or an out-of-scope bug found in review:** write a self-contained brief. Include:
  - the file paths and the evidence;
  - what "done" means;
  - "branch from origin/main";
  - "use `corepack pnpm`";
  - "self-review before opening the PR";
  - "don't set auto-merge; the manager reviews".

  **Claude Code:** put it in a `spawn_task` card, and withdraw the card with `dismiss_task` once it's superseded. **Codex:** create an issue with the brief (`gh issue create`) and tell the user. An `issue-pickup` session can take it from there.

- **A security alert** (Dependabot or GitHub advisory) is urgent:
  - check `gh api repos/Erilla/SlashWho/dependabot/alerts`;
  - find why its PR can't land. It's often `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, which is a policy: never relax it, and pin an older fixed version instead;
  - start a precise fix task;
  - tell the user straight away (**Claude Code:** with a push notification if they may be away).
