## Agent skills

### Implementation workflow

Every piece of work gets its own worktree, branched from `origin/main`. See
`docs/agents/implementation-workflow.md`.

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five standard Matt Pocock skill labels. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.

### Issue pickup and PR management

`issue-pickup` takes an issue to a green, reviewed pull request; it never
enables auto-merge. `manager` reviews and merges pull requests. Run only one
manager at a time.

Both skills work in Claude Code and Codex. Each lives as identical copies in
`.claude/skills/` and `.agents/skills/`, including the manager's
`references/`. A unit test keeps the copies in step, so edit one and copy it
over the other.

In Claude Code the manager watches PRs with background monitors and messages
sessions directly. In Codex it uses whatever the runtime offers: a heartbeat
for checking PRs, collaboration subagents for reviews, and new threads for
sessions. Where those are missing, it checks PRs when prompted and does
reviews itself. In Codex it reaches sessions through PR comments and the user. Sessions reach a manager
the same way in either tool: by opening a PR (a draft PR for a plan) or
pushing to one.
