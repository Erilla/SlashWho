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

Two skills live in `.claude/skills/`: `issue-pickup` takes an issue to a green,
reviewed pull request, and `manager` reviews and merges pull requests. Claude
Code loads them automatically. Other agents should read the `SKILL.md` files
directly; they name Claude Code tools (`SendMessage`, `ListAgents`, the PR
monitor), so use the nearest equivalent. The pickup session never enables
auto-merge; the manager decides.
