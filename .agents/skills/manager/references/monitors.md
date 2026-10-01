# Monitor scripts

**Claude Code:** run the three loops below with the Monitor tool, `timeout_ms: 1800000`. Every one polls every 180 s and uses `set +e`, so one failed `gh` call can't kill it. Re-arm each on expiry.

**Codex:** there is no Monitor tool, so don't run these loops; they never exit. Use the [Codex check pass](#codex-check-pass) instead.

## New-PR watcher (one only)

Set `LAST` to the highest PR number already handled. It reports open and already-merged PRs, so one that opens and merges between polls is still caught. Drafts are included. The watcher marks any open draft ready for review, which is a user rule.

It reports three failed polls in a row. The old version hid every `gh` failure, and in the session that built #745 it missed #751 for a whole 30-minute watch, most likely because the shared rate limit had run out. When the watcher expires silently while a session says a PR is open, check `gh pr list` yourself.

```bash
set +e
LAST=751; seen=" "; fails=0
while true; do
  if rows=$(gh pr list --repo Erilla/SlashWho --state all --limit 15 --json number,isDraft,state,title --jq ".[] | select(.number > $LAST) | \"\(.number)\t\(.state)\t\(.isDraft)\t\(.title)\"" 2>/dev/null); then
    fails=0
  else
    rows=""; fails=$((fails+1))
    [ "$fails" -eq 3 ] && echo "WATCHER: gh pr list failed 3 polls in a row (rate limit or auth?)"
  fi
  while IFS=$'\t' read -r n st draft title; do
    [ -z "$n" ] && continue
    if [ "$st" = "OPEN" ] && [ "$draft" = "true" ]; then
      if gh pr ready "$n" --repo Erilla/SlashWho >/dev/null 2>&1; then echo "DRAFT PR #$n marked ready: $title"; else echo "DRAFT PR #$n could not be marked ready: $title"; fi
    fi
    case "$seen" in *" $n "*) ;; *) seen="$seen$n "; echo "NEW PR #$n ($st): $title";; esac
  done <<<"$rows"
  sleep 180
done
```

## Tracked-PR monitor

Seed `head[N]` with the commit you last reviewed, not the live head. That way a push made while the monitor was down is still reported.

```bash
set +e
declare -A head done failed
head[740]=abcd1234; head[741]=ef567890
while true; do
  for n in "${!head[@]}"; do
    [ -n "${done[$n]}" ] && continue
    info=$(gh pr view $n --repo Erilla/SlashWho --json state,headRefOid,statusCheckRollup --jq '.state+" "+.headRefOid+" "+([.statusCheckRollup[]|select(.name=="ci")|.conclusion][0]//"none")' 2>/dev/null) || info=""
    read -r st cur ci <<<"$info"; cur=${cur:0:8}
    if [ "$st" = "MERGED" ] || [ "$st" = "CLOSED" ]; then echo "PR #$n $st"; done[$n]=1; continue; fi
    if [ -n "$cur" ] && [ "$cur" != "${head[$n]}" ]; then echo "PR #$n UPDATED: new head $cur, previous ${head[$n]}"; head[$n]=$cur; fi
    if { [ "$ci" = "FAILURE" ] || [ "$ci" = "CANCELLED" ]; } && [ "${failed[$n]}" != "$cur" ]; then echo "PR #$n ci: $ci at $cur"; failed[$n]=$cur; fi
  done
  sleep 180
done
```

## Hold monitor (only while a merge hold is in force)

```bash
set +e
last=$(gh api repos/Erilla/SlashWho/commits/main --jq .sha | cut -c1-8)
echo "Hold armed: main at $last"; declare -A warned
while true; do
  sleep 180
  cur=$(gh api repos/Erilla/SlashWho/commits/main --jq .sha 2>/dev/null | cut -c1-8)
  [ -n "$cur" ] && [ "$cur" != "$last" ] && { echo "MAIN MOVED during hold: $last -> $cur"; last=$cur; }
  for n in $(gh pr list --repo Erilla/SlashWho --state open --json number,autoMergeRequest --jq '.[]|select(.autoMergeRequest!=null)|.number' 2>/dev/null); do
    [ -z "${warned[$n]}" ] && { echo "AUTO-MERGE ENABLED during hold on #$n"; warned[$n]=1; }
  done
done
```

## Codex check pass

Run this once, each time the user prompts you. Don't run it on a loop.

It does three things:

- marks any open draft ready;
- lists every open PR with its head, CI result and auto-merge state;
- prints main's latest commit and CI result.

```bash
gh pr list --repo Erilla/SlashWho --state open --json number,isDraft --jq '.[]|select(.isDraft)|.number' |
  while read -r n; do gh pr ready "$n" --repo Erilla/SlashWho && echo "DRAFT PR #$n marked ready"; done
gh pr list --repo Erilla/SlashWho --state open --json number,headRefOid,title,autoMergeRequest,statusCheckRollup \
  --jq '.[]|"#\(.number) \(.headRefOid[0:8]) ci=\(([.statusCheckRollup[]|select(.name=="ci")|.conclusion][0])//"pending") auto=\(.autoMergeRequest!=null) \(.title)"'
gh pr list --repo Erilla/SlashWho --state merged --limit 5 --json number,title,mergedAt --jq '.[]|"merged #\(.number) \(.mergedAt) \(.title)"'
gh run list --repo Erilla/SlashWho --branch main --workflow ci.yml --limit 1 --json headSha,status,conclusion --jq '.[]|"main \(.headSha[0:8]) \(.status) \(.conclusion)"'
```

Then compare the results with what you last handled:

- **A PR you haven't seen before:** review it.
- **A head that differs from the commit you last reviewed:** the author has pushed. On a PR you reviewed, that commit is the `commit_id` of your latest review: `gh api repos/Erilla/SlashWho/pulls/N/reviews --jq '.[-1].commit_id'`.
- **A failed `ci`:** read the log (see the one-offs below).
- **A PR merged since your last pass:** tell its author, update main and check main's CI.
- **During a hold:** confirm main hasn't moved, and that no open PR shows `auto=true`.

## Useful one-offs

- **Why did CI fail?** Get the failed job ids with `gh run view <run> --json jobs`. Then run `gh api repos/Erilla/SlashWho/actions/jobs/<job>/logs | grep -E " FAIL |AssertionError|ERR_|error "`.
- **Resolve threads:** list them with `gh api graphql -f query='query{repository(owner:"Erilla",name:"SlashWho"){pullRequest(number:N){reviewThreads(first:50){nodes{id isResolved path}}}}}'`. Then resolve each with `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<ID>`.
- **Re-run CI on the current main:** `gh pr update-branch N`.
