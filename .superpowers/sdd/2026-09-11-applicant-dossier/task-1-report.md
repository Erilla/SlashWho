# Task 1 report

## Scope

Implemented the canonical applicant URL parser and pure applicant dossier aggregation model in `packages/domain`.

## TDD evidence

The worktree already contained the Task 1 production changes and tests as uncommitted changes when this task began. Therefore the prescribed pre-implementation RED command could not be rerun without discarding existing scoped work. The repository HEAD confirms the prior implementation was absent from `character-key.ts` and `index.ts`.

Observed validation commands:

```text
corepack pnpm --filter @slashwho/domain test -- character-key.test.ts
5 test files passed, 47 tests passed

corepack pnpm --filter @slashwho/domain test -- applicant-dossier.test.ts
5 test files passed, 47 tests passed
```

The GREEN implementation provides strict HTTPS/source-host dispatch, shared path validation, Warcraft Logs canonicalization, earliest per-character/boss evidence selection, shared evidence deduplication with multi-character attribution, deterministic raid/boss ordering, nullable Cutting Edge status, and limitation propagation.

## Verification

```text
corepack pnpm --filter @slashwho/domain test
5 test files passed, 47 tests passed

corepack pnpm --filter @slashwho/domain typecheck
PASS (tsc --noEmit)

corepack pnpm exec prettier --check packages/domain/src/*.ts
PASS after formatting the scoped domain files

git diff --check
PASS
```

The repository-wide `corepack pnpm format:check` remains non-zero because the pre-existing `docs/superpowers/plans/2026-09-11-applicant-dossier.md` is not formatted; that unrelated documentation file was not changed.

## Concerns

- The exact RED failure cannot be honestly reported from this worktree because the scoped implementation was present before execution began.
- Full format-check remains blocked by the unrelated pre-existing documentation formatting warning.
