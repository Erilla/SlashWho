---
name: issue-pickup
description: "Use when the user asks you to pick up, take, start or implement specific SlashWho (Erilla/SlashWho) GitHub issues, for example 'pick up #123', 'take issues 301 and 302', 'work on this issue', or when the manager spawns a session for an issue. Covers one issue through to a reviewed, green pull request that the manager merges."
---

# Issue pickup (SlashWho)

You own one issue from ticket to a green, reviewed PR. **You never merge and never enable auto-merge**: the Manager decides that. Default to UK English.

Follow `docs/agents/implementation-workflow.md` (from the repository root) for worktree, gate and review mechanics. This skill adds the hand-offs and the post-PR loop. Where the two differ, this skill wins: the workflow doc says to run `gh pr merge --auto`; **skip that**.

This skill runs in Claude Code and in Codex. Steps say **Claude Code** or **Codex** only where the tools differ.

## Steps

1. **Read each issue** with `gh issue view N --comments`. Check the timeline: a premise can be invalidated by a later merge. If it is underspecified, ask the user or label it `needs-info`; do not guess.
2. **Name the session** "Issue #N" so the Manager can find it. **Claude Code:** `mcp__ccd_session_mgmt__set_session_title`, renamed for each issue you move to. **Codex:** nothing to do; the PR carries the issue number.
3. **Several issues:** one worktree, branch and PR per issue, done serially. Do not batch them into one branch.
4. **Worktree:** `git fetch origin`, then `git worktree add -b <type>/<N>-<slug> .claude/worktrees/<type>-<N>-<slug> origin/main`, and work inside it (**Claude Code:** `EnterWorktree` with its `path`; **Codex:** `cd` into it). Never branch from local `main`. Then `corepack pnpm install --frozen-lockfile` and `cp .env.example .env`. Always `corepack pnpm`, never bare `pnpm`.
5. **Plan review, only when needed.** If the issue is large, touches migrations, budgets, rate limits, evidence publishing, discovery, identity matching or WCL queries, or has a design choice the issue leaves open, write a short plan or spec first and send it to the Manager (below). Wait for its reply before coding. Small, unambiguous fixes go straight to step 6.
6. **Implement test-first**, small conventional commits, one coherent change each.
7. **Before opening the PR:** full gate (`format:check`, `lint`, `typecheck`, `test:unit`, `test:integration`, `build`, `test:e2e`; Docker must be running), then a self-review (**Claude Code:** `/code-review low`; **Codex:** `/review` against `origin/main`, low effort), then `git merge origin/main` and re-run the gate. Read the output; a skipped suite is not a pass.
8. **Open the PR:** `gh pr create --base main` with a conventional title, `Closes #N` (or `Refs #N` for partial work) and a body of what changed, how it was verified and any risks. **No `gh pr merge --auto`.** Say "not for auto-merge; the manager decides" in the body.
9. **Tell the Manager** the PR is open (see below), then start the watch loop.

## Talking to the Manager

The Manager watches every PR, including drafts, so a PR comment always reaches it.

- **Claude Code:** run `ListAgents`, find the session named like "Manager", and `SendMessage` to it by its exact name. If none exists, tell the user.
- **Codex:** you cannot message another session. Use GitHub: for a plan, push it on the branch and open a **draft** PR titled `docs: plan for #N`; for updates, comment on the PR with `gh pr comment N`. Tell the user where you posted it.

| When                                 | Say                                                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| A plan or spec needs review          | Issue number, branch, the plan file path (pushed on the branch) or the full text, and the specific decisions you want checked |
| PR opened                            | PR link, issue number, one-line summary, what you verified, anything risky                                                    |
| You pushed fixes for review comments | PR link, the new commit, what each comment's fix was                                                                          |

Keep messages short and self-contained. The Manager reviews PRs and posts inline comments, then tells you; you do not need to ask for a review twice. For a plan, wait for its reply before coding.

## Watch loop (until the Manager merges)

The PR is yours until it lands. Never poll on a short timer: the GitHub rate limit is shared by every session.

**Claude Code:**

1. `mcp__ccd_pr__get_status`. If the PR is not reported, `bind_pr`.
2. Turn the monitor on with `set_monitor` (auto-fix). **Immediately re-check `get_status`: turning the monitor on has also enabled GitHub auto-merge before. If auto-merge is on, disable it** (`gh pr merge N --disable-auto`).
3. Handle each event as below.

**Codex:** there is no monitor. Block on `gh pr checks N --watch`, then read comments with the commands below. If the Manager has not replied, ask the user to prompt you rather than looping; when re-checking on your own, wait at least 180 s between checks.

**Handling what you find:**

- **CI failure:** read the failing log, fix the cause on the branch, run the affected local gate, push. Do not re-run CI hoping for a different result. If only e2e fails, check whether `origin/main` has the same failure before blaming your change.
- **Review comments:** read them yourself with `gh pr view N --comments` and `gh api repos/Erilla/SlashWho/pulls/N/comments`. A monitor event may omit them, so never conclude "nothing to fix" until you have looked. Verify each finding against the code, fix it or reply with reasoning if it is wrong, and push.
- **Resolve each thread you have fixed** (GraphQL `resolveReviewThread`); an open thread silently blocks the merge.
- **Conflicts or a stale base:** `git fetch origin`, merge `origin/main`, re-run the gate, push.
- After a fix push, tell the Manager (table above).
- **Merged:** the Manager will tell you, or `gh pr view N --json state` shows `MERGED`. If the issue has remaining work, start the next piece from a fresh `origin/main` in a new worktree. Otherwise clean up: remove the worktree (on Windows, `git worktree remove` can half-fail, so finish with PowerShell long-path removal), `git worktree prune`, delete the local branch.

## Red flags

| Thought                                       | Reality                                             |
| --------------------------------------------- | --------------------------------------------------- |
| "CI is green, I'll enable auto-merge"         | Merge is the Manager's call. Never.                 |
| "The event shows no comments, nothing to fix" | Read the PR comments yourself.                      |
| "It merged, so it was reviewed"               | Only the Manager's review counts; never self-merge. |
| "I'll branch from local main"                 | It is stale. Branch from `origin/main`.             |
| "I ran the tests I touched"                   | Open the PR only on the full gate.                  |
| "I'll re-run CI, it looks flaky"              | Diagnose first; confirm against `origin/main`.      |
| "I'll batch these issues into one PR"         | One issue, one branch, one PR.                      |
