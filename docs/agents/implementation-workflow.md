# Implementation workflow

How to pick up a piece of work and carry it to a merged pull request. Follow
this whenever you start implementing an issue, a bug fix, or any change that
will become its own pull request.

The rule everything else hangs off: **every piece of work gets its own isolated
worktree, branched from `origin/main`.** Never implement in the shared checkout,
and never branch from local `main`.

## 1. Read the ticket

```bash
gh issue view <number> --comments
```

Understand the acceptance criteria before creating anything. If the issue is
underspecified, ask or label it `needs-info` rather than guessing.

## 2. Create the worktree off `origin/main`

```bash
git fetch origin
git worktree add -b feat/<number>-<slug> .claude/worktrees/feat-<number>-<slug> origin/main
```

Branch and directory are derived from the same slug, so the directory always
tells you which branch it holds.

| Thing              | Convention                                            | Example                                              |
| ------------------ | ----------------------------------------------------- | ---------------------------------------------------- |
| Branch             | `<type>/<issue>-<slug>`                               | `feat/301-resume-waiting-evidence`                   |
| Worktree directory | `.claude/worktrees/` + the branch, slashes as hyphens | `.claude/worktrees/feat-301-resume-waiting-evidence` |

Branch types are the ones in [`docs/contributing.md`](../contributing.md):
`feat/`, `fix/`, `chore/`, `docs/`.

Rules:

- **Always `git fetch origin` first, and always branch from `origin/main`.** The
  local `main` ref in a long-lived checkout runs many commits stale, and
  branching from it silently gives you a months-old tree that only reveals
  itself as phantom conflicts at review time.
- **One branch, one worktree, forever.** Do not reuse an existing worktree for
  new work, and do not switch an existing worktree onto a different branch. A
  directory whose name no longer matches its branch is how sessions lose track
  of which work lives where.
- **`.claude/worktrees/` is the only location.** The legacy `.worktrees/`
  directory is retained for historic branches; do not add to it.
- Claude Code sessions should use the `EnterWorktree` tool or the
  `superpowers:using-git-worktrees` skill, which apply the same convention.

### First-time repository setup

`.claude/worktrees/` is excluded locally through `.git/info/exclude`, which is
not committed and so does not survive a fresh clone. After cloning, add it:

```bash
echo '**/.claude/worktrees/' >> .git/info/exclude
```

## 3. Prepare the worktree

A new worktree has no dependencies and no environment file:

```bash
corepack pnpm install --frozen-lockfile
cp .env.example .env
```

`pnpm` is not on `PATH` — it is reached through `corepack`. A bare `pnpm`
command fails, and piping it into another command hides that failure.

## 4. Implement

Work test-first. Run the relevant gates before claiming anything works:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm test:integration
```

Integration and browser tests need Docker running.

Commit with conventional prefixes, one coherent change per commit. Keep the
branch short-lived.

## 5. Open the pull request

```bash
gh pr create --base main --title "<conventional title>" --body "..."
gh pr merge --auto --squash
```

Auto-merge still gates on CI here even though the branch-protection API reports
`main` as unprotected, so `--auto` is safe to set as soon as the pull request
opens.

Resolve review conversations, let the checks pass, and validate the resulting
`main` deployment in staging.

## 6. Clean up

Once the pull request is merged, remove the worktree in the same session that
finished the work. Stale worktrees accumulate quickly and make it impossible to
tell which directories hold live work.

```bash
git worktree remove .claude/worktrees/<directory>
git branch -d <branch>
git worktree prune
```

Run `git worktree list` from the shared checkout to audit what is still open.

## Hazards

| Symptom                                       | Cause                                            |
| --------------------------------------------- | ------------------------------------------------ |
| Conflicts against code you never touched      | Branched from a stale local `main`               |
| Directory name does not match its branch      | A worktree was reused for a second piece of work |
| `pnpm: command not found`, or a silent no-op  | Missing the `corepack` prefix                    |
| Tests pass locally but CI fails on migrations | Docker not running, so integration tests skipped |
