# Contributing

## Branch strategy

- `main` is the trunk and deploys to the persistent Railway staging environment, named `test`.
- `prod` represents the version deployed to Railway production, in the environment named `prod`.
- Feature branches use `feat/<short-description>`.
- Bug fixes use `fix/<short-description>`.
- Maintenance and documentation use `chore/<short-description>` or `docs/<short-description>`.

Branches should be short-lived and contain one coherent change. There is no `develop` branch.

## Pull-request flow

1. Create an isolated worktree, branched from `origin/main`, as described in [`docs/agents/implementation-workflow.md`](agents/implementation-workflow.md).
2. Make one coherent change.
3. Run the full gate — format, lint, typecheck, tests, build — and see it pass.
4. Merge `origin/main` back in, resolve any conflicts, and run the gate again.
5. Open a pull request targeting `main` and set auto-merge.
6. Resolve review conversations and ensure all required checks pass.
7. Squash-merge the pull request using a conventional title.
8. Validate the resulting `main` deployment in staging and remove the worktree.

Use conventional commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, and `chore:`. Add a scope when it makes the affected area clearer, for example `feat(api): add character lookup`.

## Database migrations

Migrations in `packages/database/drizzle/` are written by hand. `drizzle-kit generate` is not used: `schema.ts` describes the tables the application queries, not the whole migrated database, which also holds trigger functions, applicant-watcher tables and foreign keys named differently from drizzle-kit's defaults. There is no drizzle-kit config and no snapshot under `drizzle/meta/`; the journal is the only file there.

To add a migration:

1. Write `drizzle/NNNN_<slug>.sql`, numbered one past the newest file. Separate statements with `--> statement-breakpoint`.
2. Append an entry to `drizzle/meta/_journal.json` with the next `idx`, the same `tag` as the file name without `.sql`, `"version": "7"` and `"breakpoints": true`.
3. Set `when` to `max(now, previous + 1)`: the current time in epoch milliseconds, or one more than the previous entry's `when` if that is later.

The rule for `when` is not cosmetic. The migrator applies an entry only if its `when` is later than the newest `created_at` already recorded in `drizzle.__drizzle_migrations`. An entry dated before its predecessor applies on a fresh database, so every local test passes, and is silently skipped on every database that has already applied the predecessor. Older entries were dated in the future, so for now `previous + 1` is usually the larger value.

`packages/database/src/migration-journal.test.ts` fails the build if `when` does not strictly increase, if a journal entry and a `.sql` file do not match one to one, or if a snapshot reappears.

## Production promotion

Production is promoted only by fast-forwarding `prod` to a commit already validated on `main`:

```bash
git fetch origin
git push origin origin/main:prod
```

Never commit directly to `prod`, merge unrelated work into it, or force-push it. Keep `main` releasable so urgent fixes do not require bypassing staged work.

## Repository automation

The `ci` workflow (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `main` and `prod`. Its final job, `ci`, is the only required status check: the `main` and `prod` rulesets both require it, and the `main` ruleset also requires a pull request, squash merges, linear history and resolved review threads. The `claude-code-review` workflow posts an advisory review and is not required; see [`docs/agents/implementation-workflow.md`](agents/implementation-workflow.md). Railway deployment is described in [`docs/deployment/railway.md`](deployment/railway.md).
