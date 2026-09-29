# Review subagent brief

Launch a `general-purpose` Agent in the background. Fill in the `<…>` parts and add the relevant sections of lessons.md. Keep the brief specific: say what could go wrong for this change, not generic advice.

```
Review PR #<N> in Erilla/SlashWho ("<title>"). Decide whether it solves the issue it is linked to (read the PR body and linked issue via `gh`), and whether it is correct and safe. Write in UK English.

<Say also if a merge hold is in force: "MERGE HOLD: do NOT set auto-merge and do NOT merge, whatever your verdict.">

Setup and rules:
- Work from <manager worktree path> (Windows, Git Bash).
- Run `git fetch origin --prune` first and compare against the fresh origin/main (<sha> or later).
- Main recently gained <relevant merged PRs and what they changed>. Lint and test the MERGED tree.
- Prefix `git show ref:path` with MSYS_NO_PATHCONV=1.
- Check the merge-base and whether it merges cleanly: `git merge-tree --write-tree origin/main origin/<branch>`.
- <List open PRs that overlap in behaviour. If they overlap, test on a tree containing both; a clean merge-tree is not enough.>
- <If a migration may be involved: its number must follow <latest>, and no other open PR may claim the same number.>
- Keep `gh` calls to a minimum; the shared 5,000/hr limit has run out before. Read code with local git.
- Before posting, check `gh pr view <N> --json state`. If it has already merged, still post real findings, marked post-merge.

What to check:
<Area-specific risks from lessons.md, phrased as questions about this diff>
- Are the tests meaningful, and would they fail without the change?

Running tests:
- Use a temp worktree at the PR head merged with origin/main (a temp directory outside the repo).
- Use `corepack pnpm` (bare pnpm is not on PATH): `install --frozen-lockfile`, the relevant unit tests, typecheck and lint.
- Run integration tests if repositories or migrations changed and Docker is available. Rely on CI for e2e.
- If a frozen install fails with ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION, report it and do not bypass it.
- Remove the worktree afterwards with PowerShell long-path removal (`Remove-Item -LiteralPath '\\?\C:\...' -Recurse -Force`), then `git worktree prune`.

Outcome:
- If there are problems, post ONE PR review with inline comments on the diff lines:
  - Use `gh api repos/Erilla/SlashWho/pulls/<N>/reviews --method POST --input <json>` with `{commit_id: <head sha>, event: "COMMENT", body, comments: [{path, line, side: "RIGHT", body}]}`.
  - Write the JSON to the session scratchpad as pr<N>-review.json and check it with `iconv -f UTF-8 -t UTF-8` before posting.
  - Every finding on a diff line must be inline. Only findings outside the diff go in the body. Optional suggestions go in the body, not as threads, since open threads block auto-merge.
  - Do not set auto-merge.
- If it is fine, run `gh pr merge <N> --auto --squash` and post nothing. If a permission check blocks that, report it; don't work around it.
- Report back concisely: verdict, what you verified (with arithmetic where budgets are involved), test results, the review URL if you posted one, and whether it had merged before you finished.
```

**Splitting a very large PR** (#745, about 14,700 lines) between two reviewers:

- Split it by area, for example one reviewer on the write path and database, the other on the replay and ops.
- Give each reviewer its own temp worktree path.
- Tell both to report back, not post. You then post one combined review, after checking every inline line with `git diff -U0` against the PR's hunks.
- Two concurrent temp installs can break each other's `node_modules` (vite's `dist/client` vanished in #745). Tell reviewers to reinstall if files go missing mid-run.

**If the author resolves threads themselves,** treat that as a claim. The re-reviewer checks each one and reopens any that isn't really fixed, with `unresolveReviewThread`.

For a re-review after fixes, add the old review's URL, and list each thread with what the fix must satisfy. Tell the reviewer to resolve only the threads whose point is really fixed.
