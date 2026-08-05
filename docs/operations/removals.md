# Character removal operations

Removal means suppression from every public current, history, snapshot, and job-status response. It does not delete immutable snapshots or rewrite historical membership.

## Intake and staging verification

1. Accept requests only through the public removal-request issue template. Ask for private ownership evidence through a private maintainer channel if it is needed; never request it in GitHub comments.
2. Normalize the submitted Raider.IO URL and record the GitHub issue number as the reason, for example `github-issue-123`.
3. Link the repository to Railway, then apply and verify the suppression in staging first:

```bash
railway run --service web --environment staging corepack pnpm ops:removals -- add "https://raider.io/characters/eu/silvermoon/Ryii" --reason "github-issue-123"
railway run --service web --environment staging corepack pnpm ops:removals -- audit "https://raider.io/characters/eu/silvermoon/Ryii"
railway run --service web --environment staging corepack pnpm ops:removals -- verify "https://raider.io/characters/eu/silvermoon/Ryii"
```

The command prints only the canonical public character identity and whether suppression is active. `verify` exits with status 2 when it is inactive. Confirm the public character, history, snapshot, and any known job URL all return the safe not-found response.

## Production suppression

Run the same commands against production, using the exact reviewed URL and issue reason:

```bash
railway run --service web --environment production corepack pnpm ops:removals -- add "https://raider.io/characters/eu/silvermoon/Ryii" --reason "github-issue-123"
railway run --service web --environment production corepack pnpm ops:removals -- verify "https://raider.io/characters/eu/silvermoon/Ryii"
```

For a time-bounded suppression, provide an ISO-8601 UTC expiry:

```bash
railway run --service web --environment production corepack pnpm ops:removals -- add "https://raider.io/characters/eu/silvermoon/Ryii" --reason "github-issue-123" --expires-at "2027-01-01T00:00:00Z"
```

Close the request only after recording the canonical identity, issue reason, environment, command timestamp, and verification result in the private operations log. Do not record credentials or ownership evidence.

## Expiry and rollback

An intentional early expiry uses the repository operation below; it does not touch snapshots:

```bash
railway run --service web --environment staging corepack pnpm ops:removals -- expire "https://raider.io/characters/eu/silvermoon/Ryii"
railway run --service web --environment production corepack pnpm ops:removals -- expire "https://raider.io/characters/eu/silvermoon/Ryii"
```

Audit both environments after expiry. The character becomes eligible for a future refresh; retained snapshots remain unchanged. Never use ad-hoc production SQL or delete rows to process a removal request.
