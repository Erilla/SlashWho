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
enables auto-merge. It works in Claude Code and Codex, and lives as identical
copies in `.claude/skills/` and `.agents/skills/` (a unit test keeps them in
step: edit one, copy it over the other).

`manager` reviews and merges pull requests. It is Claude Code only, in
`.claude/skills/manager/`, because it depends on Claude Code's session
messaging and PR monitors. Codex sessions reach it through GitHub: a PR
comment, or a draft PR for a plan.
