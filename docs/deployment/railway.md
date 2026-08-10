# Railway deployment

SlashWho runs as three Railway services in each environment: PostgreSQL, the public web/API service, and a private worker. The web and worker images both run the advisory-locked Drizzle migrations before application startup. Only the web service receives a public domain.

The checked-in settings follow Railway's current [config-as-code reference](https://docs.railway.com/config-as-code/reference), [Dockerfile guidance](https://docs.railway.com/builds/dockerfiles), and [public networking header contract](https://docs.railway.com/networking/public-networking/specs-and-limits). Recheck those pages when changing the deployment boundary.

## Create staging and production

The environments are named `test` (staging, deploys `main`) and `prod` (production, deploys `prod`), matching SeriouslyCasualBotV2's Railway environments so both projects read the same way.

1. Create one Railway project with isolated `test` and `prod` environments.
2. In each environment, add a Railway PostgreSQL service, a web service from this repository, and a worker service from this repository.
3. Set the web service's config-as-code path to `/railway.web.toml`; set the worker's to `/railway.worker.toml`.
4. Confirm the web build uses `Dockerfile.web` and the worker build uses `Dockerfile.worker`.
5. Add `DATABASE_URL` to both app services as a private reference to the environment's PostgreSQL `DATABASE_URL`. Do not paste the public TCP proxy URL into any service variable. Maintainer commands that must reach the database from outside Railway read `DATABASE_PUBLIC_URL` from the PostgreSQL service transiently instead; see [`docs/operations/removals.md`](../operations/removals.md).
6. Generate a public domain for web only. Do not expose the worker or PostgreSQL services publicly.
7. Configure both services to deploy `main` in `test` and `prod` in `prod`. Disable direct production deploys from feature branches.

Steps 3 and 4 have no Railway CLI flag. Set the config-as-code path from each service's settings page, or through the public API:

```bash
# serviceInstanceUpdate(environmentId, serviceId, input: { railwayConfigFile })
# web -> /railway.web.toml, worker -> /railway.worker.toml
```

Neither Dockerfile uses a BuildKit cache mount. Railway's Metal builder accepts one only when its id is literally `s/<service id>-<target path>`, and [its Dockerfile guide](https://docs.railway.com/builds/dockerfiles) notes that environment variables are invalid inside a cache mount id — so keeping the mount would mean hardcoding this project's Railway service UUIDs, differently per service, into files that CI and local builds also use. Docker layer caching already covers the install step unless the lockfile changes, so the mount was dropped instead. Do not reintroduce one without that literal id; local Docker accepts ids Railway rejects, so the failure appears only on deploy.

## Variables

Set different values in staging and production. Secrets must be Railway secret variables, never checked into the repository.

Web variables:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
BOT_API_KEY=<at least 32 random characters>
RATE_LIMIT_HASH_SECRET=<different value, at least 32 random characters>
ANONYMOUS_SEARCHES_PER_HOUR=10
BOT_SEARCHES_PER_HOUR=60
PUBLIC_READS_PER_MINUTE=300
FRESHNESS_HOURS=24
```

Worker variables. `DISCOVERY_REQUEST_CAP`, `NEGATIVE_CACHE_TTL_MS`, and the
Blizzard fingerprint settings are read only by the worker, so set them on the
worker service alone. `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET` must
be Railway secret variables. `NEGATIVE_CACHE_TTL_MS` defaults to 300000
milliseconds (5 minutes) when unset; the fingerprint budget defaults shown
below are the application defaults and can be omitted after the required
credentials and sweep cap are configured:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
DISCOVERY_REQUEST_CAP=12
NEGATIVE_CACHE_TTL_MS=300000
RAIDER_IO_BASE_URL=https://raider.io
RAIDER_IO_TIMEOUT_MS=10000
DATABASE_STARTUP_ATTEMPTS=5
DATABASE_STARTUP_RETRY_MS=1000
WORKER_DRAIN_TIMEOUT_MS=30000
WORKER_HEALTH_HOST=0.0.0.0
BLIZZARD_CLIENT_ID=<Blizzard OAuth client ID secret>
BLIZZARD_CLIENT_SECRET=<Blizzard OAuth client secret>
BLIZZARD_SWEEP_REQUEST_CAP=300
BLIZZARD_HOURLY_REQUEST_BUDGET=28800
FINGERPRINT_MINIMUM_COMMON=200
FINGERPRINT_MINIMUM_IDENTICAL_PERCENT=20
FINGERPRINT_SWEEP_CADENCE_HOURS=168
```

Railway currently documents `X-Real-IP` as the single remote-client header supplied by its public proxy. SlashWho intentionally accepts only that header for anonymous rate-limit identity and fails closed when it is absent or invalid; it does not trust an arbitrary forwarded chain or a runtime-selectable header name. Verify this exact contract against Railway's public-networking documentation before first launch and after any proxy change.

## Health, readiness, and restarts

- Web `/health` is process-only. Web `/ready` runs the shared migrations during container initialization and then verifies PostgreSQL connectivity.
- Worker `/health` is process-only. Worker `/ready` requires PostgreSQL and a started pg-boss queue/consumer.
- Both Railway configs gate deployment on `/ready` and restart failed processes up to ten times.
- Worker draining is 35 seconds, longer than the default 30-second job drain, so graceful shutdown gets the full settlement window.

After each staging deploy, verify `/health`, `/ready`, one new search, one stale refresh, one immutable historical snapshot, rate limiting, a suppressed character, and a graceful worker restart. Promote only the validated `main` commit by fast-forwarding `prod`.

## Backups

**Production currently has no backups, and this is a known, accepted gap.**

Railway's scheduled volume backups and point-in-time recovery are paid-plan features. This project runs on the Hobby plan, so the [backup guide](https://docs.railway.com/volumes/backups)'s daily/weekly/monthly schedules cannot be enabled — the API rejects `volumeInstanceBackupScheduleUpdate` with `Not Authorized`, and both the schedule list and the backup list are empty for every environment. An earlier revision of this document instructed enabling them anyway; that instruction was impossible to follow.

### What a lost volume would actually cost

| Table                                                        | Recoverability                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `suppressedCharacters`                                       | **Reconstructible.** Every suppression records its GitHub issue number as the reason, so the list can be rebuilt by re-running `ops:removals add` from the issues and the private operations log. This is what makes [`docs/operations/removals.md`](../operations/removals.md)'s "record the canonical identity, issue reason, environment, command timestamp" step load-bearing rather than merely tidy — it is the off-database copy of a privacy commitment. |
| `snapshots`, `snapshotCharacters`                            | **Irreplaceable.** A fresh search rediscovers the _current_ alt list; nothing rediscovers what it looked like last month. This is the dated history the product promises, and it is the only genuinely unrecoverable data.                                                                                                                                                                                                                                       |
| `characters`                                                 | Regenerable by searching again.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `discoveryRuns`, `rateLimitEvents`, `negativeCharacterCache` | Operational and short-lived; regenerable.                                                                                                                                                                                                                                                                                                                                                                                                                        |

The exposure therefore grows with time rather than being constant. Shortly after launch the irreplaceable set is a handful of snapshots and losing it would barely matter; after a year of accumulated history it is the product.

### Taking a manual checkpoint

`pg_dump` has to reach the database from outside Railway, so it needs the public connection string rather than the private `${{Postgres.DATABASE_URL}}` reference — the same constraint, and the same transient-export pattern, as [`docs/operations/removals.md`](../operations/removals.md). Enable the PostgreSQL service's TCP proxy for the environment first.

Running the client in Docker avoids installing a matching client locally, and the image tag must match the server's major version (the service runs `postgres-ssl:18`):

```bash
export DATABASE_URL="$(railway variables list --service Postgres --environment prod --kv | sed -n 's/^DATABASE_PUBLIC_URL=//p')"
test -n "$DATABASE_URL" || echo "enable the Postgres TCP proxy for this environment first"
docker run --rm -e DATABASE_URL postgres:18-alpine \
  pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > "slashwho-prod-$(date -u +%Y%m%dT%H%M%SZ).dump"
unset DATABASE_URL
```

Restore with `pg_restore --clean --if-exists --no-owner --no-privileges -d "$DATABASE_URL" <file>`. Store dumps outside this repository: they contain the suppression list and the full character corpus, and this repository is public. A dump that has never been restored is not a verified backup — restore one into a scratch database before relying on it.

### When to revisit

Add automation once the accumulated history is worth more than the effort of protecting it. The option that does not require a plan upgrade is a small scheduled Railway service running the dump above inside the private network and uploading to object storage — no TCP proxy, no public exposure. Upgrading the Railway plan is the alternative, and buys point-in-time recovery as well as scheduled snapshots.

## Local artifact validation

```bash
docker build -f Dockerfile.web -t slashwho-web:local .
docker build -f Dockerfile.worker -t slashwho-worker:local .
docker run --rm slashwho-web:local node --version
docker run --rm slashwho-worker:local node --version
railway --version
python -c "import pathlib,tomllib; [tomllib.loads(pathlib.Path(p).read_text()) for p in ('railway.web.toml','railway.worker.toml')]"
```

Railway CLI 5.20.0 no longer exposes the former standalone TOML `config validate` command; its `railway config plan` command targets linked-project `.railway/railway.ts` infrastructure instead. Before creating services, compare both TOMLs with Railway's current config-as-code schema/reference and parse them as above. Once staging is linked, deploy each config and inspect the deployment details' resolved build/deploy configuration before enabling production autodeploys.
