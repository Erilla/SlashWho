# Railway deployment

SlashWho runs as three Railway services in each environment: PostgreSQL, the public web/API service, and a private worker. The web and worker images both run the advisory-locked Drizzle migrations before application startup. Only the web service receives a public domain.

The checked-in settings follow Railway's current [config-as-code reference](https://docs.railway.com/config-as-code/reference), [Dockerfile guidance](https://docs.railway.com/builds/dockerfiles), and [public networking header contract](https://docs.railway.com/networking/public-networking/specs-and-limits). Recheck those pages when changing the deployment boundary.

## Create staging and production

1. Create one Railway project with isolated `staging` and `production` environments.
2. In each environment, add a Railway PostgreSQL service, a web service from this repository, and a worker service from this repository.
3. Set the web service's config-as-code path to `/railway.web.toml`; set the worker's to `/railway.worker.toml`.
4. Confirm the web build uses `Dockerfile.web` and the worker build uses `Dockerfile.worker`.
5. Add `DATABASE_URL` to both app services as a private reference to the environment's PostgreSQL `DATABASE_URL`. Do not paste the public TCP proxy URL into any service variable. Maintainer commands that must reach the database from outside Railway read `DATABASE_PUBLIC_URL` from the PostgreSQL service transiently instead; see [`docs/operations/removals.md`](../operations/removals.md).
6. Generate a public domain for web only. Do not expose the worker or PostgreSQL services publicly.
7. Configure both services to deploy `main` in staging and `prod` in production. Disable direct production deploys from feature branches.

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

Worker variables. `DISCOVERY_REQUEST_CAP` and `NEGATIVE_CACHE_TTL_MS` are read only by the worker, so set them on the worker service alone; `NEGATIVE_CACHE_TTL_MS` defaults to 300000 milliseconds (5 minutes) when unset:

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
```

Railway currently documents `X-Real-IP` as the single remote-client header supplied by its public proxy. SlashWho intentionally accepts only that header for anonymous rate-limit identity and fails closed when it is absent or invalid; it does not trust an arbitrary forwarded chain or a runtime-selectable header name. Verify this exact contract against Railway's public-networking documentation before first launch and after any proxy change.

## Health, readiness, and restarts

- Web `/health` is process-only. Web `/ready` runs the shared migrations during container initialization and then verifies PostgreSQL connectivity.
- Worker `/health` is process-only. Worker `/ready` requires PostgreSQL and a started pg-boss queue/consumer.
- Both Railway configs gate deployment on `/ready` and restart failed processes up to ten times.
- Worker draining is 35 seconds, longer than the default 30-second job drain, so graceful shutdown gets the full settlement window.

After each staging deploy, verify `/health`, `/ready`, one new search, one stale refresh, one immutable historical snapshot, rate limiting, a suppressed character, and a graceful worker restart. Promote only the validated `main` commit by fast-forwarding `prod`.

## Backups

Before production launch, open the PostgreSQL service's **Backups** tab and enable at least daily scheduled volume backups. Railway documents daily, weekly, and monthly schedules in its [backup guide](https://docs.railway.com/volumes/backups). Record a restore drill in the launch checklist; a schedule that has never been restored is not a verified backup. For a longer recovery window, evaluate Railway's PostgreSQL point-in-time recovery separately.

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
