# Character removal operations

Removal means suppression from every public current, history, snapshot, and job-status response. It does not delete immutable snapshots or rewrite historical membership.

## Connecting the maintainer shell

`ops:removals` is a repository command that runs on the maintainer's machine, so it needs a `DATABASE_URL` that resolves from outside Railway's network.

Do not use `railway run --service web`: that also executes locally, and the web service's `DATABASE_URL` is deliberately the private `${{Postgres.DATABASE_URL}}` reference, whose `*.railway.internal` host only resolves inside the Railway private network. `railway ssh` is not an alternative either — neither deployed image contains `scripts/` or pnpm; they carry only the runtime and migration artifacts.

Instead, enable the PostgreSQL service's TCP proxy once per environment and read its public connection string into the shell for the duration of the command. The app services keep the private reference; the public URL is never stored as a service variable.

```bash
railway link
export DATABASE_URL="$(railway variables list --service Postgres --environment staging --kv | sed -n 's/^DATABASE_PUBLIC_URL=//p')"
test -n "$DATABASE_URL" || echo "enable the Postgres TCP proxy for this environment first"
```

Run `unset DATABASE_URL` when the operation is finished, and never paste the value into a file, an issue, or the operations log.

## Intake and staging verification

1. Accept requests only through the public removal-request issue template. Ask for private ownership evidence through a private maintainer channel if it is needed; never request it in GitHub comments.
2. Normalize the submitted Raider.IO URL and record the GitHub issue number as the reason, for example `github-issue-123`.
3. Export the staging `DATABASE_URL` as above, then apply and verify the suppression in staging first:

```bash
corepack pnpm ops:removals -- add "https://raider.io/characters/eu/silvermoon/Ryii" --reason "github-issue-123"
corepack pnpm ops:removals -- audit "https://raider.io/characters/eu/silvermoon/Ryii"
corepack pnpm ops:removals -- verify "https://raider.io/characters/eu/silvermoon/Ryii"
```

The command prints only the canonical public character identity and whether suppression is active. `verify` exits with status 2 when it is inactive. Confirm the public character, history, snapshot, and any known job URL all return the safe not-found response.

## Production suppression

Re-export `DATABASE_URL` from the production PostgreSQL service, then run the same commands using the exact reviewed URL and issue reason:

```bash
export DATABASE_URL="$(railway variables list --service Postgres --environment production --kv | sed -n 's/^DATABASE_PUBLIC_URL=//p')"
corepack pnpm ops:removals -- add "https://raider.io/characters/eu/silvermoon/Ryii" --reason "github-issue-123"
corepack pnpm ops:removals -- verify "https://raider.io/characters/eu/silvermoon/Ryii"
```

For a time-bounded suppression, provide an ISO-8601 UTC expiry:

```bash
corepack pnpm ops:removals -- add "https://raider.io/characters/eu/silvermoon/Ryii" --reason "github-issue-123" --expires-at "2027-01-01T00:00:00Z"
```

Close the request only after recording the canonical identity, issue reason, environment, command timestamp, and verification result in the private operations log. Do not record credentials or ownership evidence.

## Expiry and rollback

An intentional early expiry uses the repository operation below; it does not touch snapshots. Export `DATABASE_URL` for one environment at a time so an expiry cannot be applied to the wrong environment:

```bash
corepack pnpm ops:removals -- expire "https://raider.io/characters/eu/silvermoon/Ryii"
corepack pnpm ops:removals -- audit "https://raider.io/characters/eu/silvermoon/Ryii"
unset DATABASE_URL
```

Audit both environments after expiry. The character becomes eligible for a future refresh; retained snapshots remain unchanged. Never use ad-hoc production SQL or delete rows to process a removal request.
