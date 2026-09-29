---
name: issue-pickup
description: "Use when the user asks you to pick up, take, start or implement specific SlashWho (Erilla/SlashWho) GitHub issues, for example 'pick up #123', 'take issues 301 and 302', 'work on this issue', or when the manager spawns a session for an issue. Covers one issue through to a reviewed, green pull request that the manager merges."
---

# Issue pickup (SlashWho)

You own one issue from ticket to a green, reviewed PR. **You never merge and never enable auto-merge**: the Manager session decides that. Default to UK English.

Follow `docs/agents/implementation-workflow.md` (from the repository root) for worktree, gate and review mechanics. This skill adds the hand-offs and the post-PR loop. Where the two differ, this skill wins: the workflow doc says to run `gh pr merge --auto`; **skip that**.

## Steps

1. **Read each issue** with `gh issue view N --comments`. Check the timeline: a premise can be invalidated by a later merge. If it is underspecified, ask the user or label it `needs-info`; do not guess.
2. **Several issues:** one worktree, branch and PR per issue, done serially. Do not batch them into one branch.
3. **Worktree:** `git fetch origin`, then `git worktree add -b <type>/<N>-<slug> .claude/worktrees/<type>-<N>-<slug> origin/main`, then `EnterWorktree` with its `path`. Never branch from local `main`. Then `corepack pnpm install --frozen-lockfile` and `cp .env.example .env`. Always `corepack pnpm`, never bare `pnpm`.
4. **Plan review, only when needed.** If the issue is large, touches migrations, budgets, rate limits, evidence publishing, discovery, identity matching or WCL queries, or has a design choice the issue leaves open, write a short plan or spec first and send it to the Manager (below). Wait for its reply before coding. Small, unambiguous fixes go straight to step 5.
5. **Implement test-first**, small conventional commits, one coherent change each.
6. **Before opening the PR:** full gate (`format:check`, `lint`, `typecheck`, `test:unit`, `test:integration`, `build`, `test:e2e`; Docker must be running), `/code-review low`, then `git merge origin/main` and re-run the gate. Read the output; a skipped suite is not a pass.
7. **Open the PR:** `gh pr create --base main` with a conventional title, `Closes #N` (or `Refs #N` for partial work) and a body of what changed, how it was verified and any risks. **No `gh pr merge --auto`.** Say "not for auto-merge; the manager decides" in the body.
8. **Tell the Manager** the PR is open (see below), then start the watch loop.

## Talking to the Manager

Run `ListAgents` and find the session named like "Manager". Use `SendMessage` with `to` set to its name exactly. If none exists, tell the user and carry on, or wait for a plan reply.

| When                                 | Send                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| A plan or spec needs review          | Issue number, branch, the plan file path (pushed on the branch) or the full text, and the specific decisions you want checked |
| PR opened                            | PR link, issue number, one-line summary, what you verified, anything risky                                                    |
| You pushed fixes for review comments | PR link, the new commit, what each comment's fix was                                                                          |

Keep messages short and self-contained. The Manager reviews PRs and posts inline comments, then messages you; you do not need to ask for a review twice.

## Watch loop (until the Manager merges)

The PR is yours until it lands. Do not poll `gh` on a timer or schedule wake-ups: use the app's PR tools.

1. `mcp__ccd_pr__get_status`. If the PR is not reported, `bind_pr`.
2. Turn the monitor on with `set_monitor` (auto-fix). **Immediately re-check `get_status`: turning the monitor on has also enabled GitHub auto-merge before. If auto-merge is on, disable it** (`gh pr merge N --disable-auto`).
3. On each event:
   - **CI failure:** read the failing log, fix the cause on the branch, run the affected local gate, push. Do not re-run CI hoping for a different result. If only e2e fails, check whether `origin/main` has the same failure before blaming your change.
   - **Review comments:** read them yourself with `gh pr view N --comments` and `gh api repos/Erilla/SlashWho/pulls/N/comments`. The event may omit them, so never conclude "nothing to fix" until you have looked. Verify each finding against the code, fix it or reply with reasoning if it is wrong, and push.
   - **Resolve each thread you have fixed** (GraphQL `resolveReviewThread`); an open thread silently blocks the merge.
   - **Conflicts or a stale base:** `git fetch origin`, merge `origin/main`, re-run the gate, push.
4. After a fix push, message the Manager (table above).
5. **Merged:** the Manager will tell you. If the issue has remaining work, start the next piece from a fresh `origin/main` in a new worktree. Otherwise clean up: remove the worktree (on Windows, `git worktree remove` can half-fail, so finish with PowerShell long-path removal), `git worktree prune`, delete the local branch.

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
