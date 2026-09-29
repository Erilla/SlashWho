# Monitor scripts

Run these with the Monitor tool, `timeout_ms: 1800000`. Every one polls every 180 s and uses `set +e`, so one failed `gh` call can't kill it. Re-arm each on expiry.

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

## Useful one-offs

- **Why did CI fail?** Get the failed job ids with `gh run view <run> --json jobs`. Then run `gh api repos/Erilla/SlashWho/actions/jobs/<job>/logs | grep -E " FAIL |AssertionError|ERR_|error "`.
- **Resolve threads:** list them with `gh api graphql -f query='query{repository(owner:"Erilla",name:"SlashWho"){pullRequest(number:N){reviewThreads(first:50){nodes{id isResolved path}}}}}'`. Then resolve each with `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<ID>`.
- **Re-run CI on the current main:** `gh pr update-branch N`.
