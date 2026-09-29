# Character removal operations

Removal means internal suppression from future discovery and dossier reads. It does not delete immutable snapshots or rewrite historical membership.

A removed character is also hidden from other characters' dossiers: they no longer appear on any Raider.IO kill roster. Their roster rows are kept, and filtered out whenever a dossier is read, so the roster's player and role counts still include them. When the suppression expires, they appear on those rosters again.

## Connecting the maintainer shell

`ops:removals` is a repository command that runs on the maintainer's machine, so it needs a `DATABASE_URL` that resolves from outside Railway's network.

Do not use `railway run --service web`: that also executes locally, and the web service's `DATABASE_URL` is deliberately the private `${{Postgres.DATABASE_URL}}` reference, whose `*.railway.internal` host only resolves inside the Railway private network. `railway ssh` is not an alternative either — neither deployed image contains `scripts/` or pnpm; they carry only the runtime and migration artifacts.

Instead, enable the PostgreSQL service's TCP proxy once per environment and read its public connection string into the shell for the duration of the command. The app services keep the private reference; the public URL is never stored as a service variable.

```bash
railway link
pg_vars="$(railway variables list --service Postgres --environment test --kv)"
pg_var() { printf '%s\n' "$pg_vars" | sed -n "s/^$1=//p"; }
DATABASE_URL="$(pg_var DATABASE_PUBLIC_URL)"
if [ -z "$DATABASE_URL" ]; then
  DATABASE_URL="$(PGU="$(pg_var PGUSER)" PGP="$(pg_var PGPASSWORD)" PGD="$(pg_var PGDATABASE)" \
    PH="$(pg_var RAILWAY_TCP_PROXY_DOMAIN)" PP="$(pg_var RAILWAY_TCP_PROXY_PORT)" node -e '
      const e = process.env;
      if (e.PGU && e.PGP && e.PGD && e.PH && e.PP)
        process.stdout.write(`postgresql://${encodeURIComponent(e.PGU)}:${encodeURIComponent(e.PGP)}@${e.PH}:${e.PP}/${encodeURIComponent(e.PGD)}`);
    ')"
fi
export DATABASE_URL
unset pg_vars
test -n "$DATABASE_URL" || echo "enable the Postgres TCP proxy for this environment first"
node -e 'const u = new URL(process.env.DATABASE_URL); console.log(`${u.host}${u.pathname}`)'
```

Not every environment's Postgres service defines `DATABASE_PUBLIC_URL` (`test` does not), so the block falls back to building the same URL from `PGUSER`, `PGPASSWORD`, `PGDATABASE` and the TCP proxy's `RAILWAY_TCP_PROXY_DOMAIN` and `RAILWAY_TCP_PROXY_PORT`, URL-encoding the user, password and database. It never echoes the URL or the password: its last line prints only `host:port/database`.

Railway's proxy hosts are shared across environments and differ only by port, so check both the host and the port against the intended environment before running anything:

```bash
railway variables list --service Postgres --environment test --kv | grep -E '^(RAILWAY_ENVIRONMENT_NAME|RAILWAY_TCP_PROXY_DOMAIN|RAILWAY_TCP_PROXY_PORT|PGDATABASE)='
```

Run `unset DATABASE_URL` when the operation is finished, and never paste the value into a file, an issue, or the operations log.

## Intake and staging verification

1. Accept requests through maintainer intake. Ask for private ownership evidence through a private maintainer channel if it is needed; never request it in GitHub comments.
2. Normalize the submitted Raider.IO URL and record the GitHub issue number as the reason, for example `github-issue-123`.
3. Export the `test` environment's `DATABASE_URL` as above, then apply and verify the suppression in staging first:

```bash
corepack pnpm ops:removals -- add "https://raider.io/characters/eu/silvermoon/Ryii" --reason "github-issue-123"
corepack pnpm ops:removals -- audit "https://raider.io/characters/eu/silvermoon/Ryii"
corepack pnpm ops:removals -- verify "https://raider.io/characters/eu/silvermoon/Ryii"
```

The command prints only the canonical character identity and whether suppression is active. `verify` exits with status 2 when it is inactive. Confirm the character no longer appears in a new dossier read.

## Production suppression

Re-export `DATABASE_URL` from the production PostgreSQL service, then run the same commands using the exact reviewed URL and issue reason:

```bash
export DATABASE_URL="$(railway variables list --service Postgres --environment prod --kv | sed -n 's/^DATABASE_PUBLIC_URL=//p')"
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
