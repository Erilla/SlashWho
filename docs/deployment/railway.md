# Railway deployment

SlashWho runs as three services in a fresh Railway project: PostgreSQL, an unlisted web dossier service, and a worker whose public surface is limited to operational health endpoints. The web and worker images both run the advisory-locked Drizzle migrations before application startup. The web service is not a public API or searchable directory, and the worker never exposes application or character routes.

The checked-in settings follow Railway's current [config-as-code reference](https://docs.railway.com/config-as-code/reference), [Dockerfile guidance](https://docs.railway.com/builds/dockerfiles), and [public networking header contract](https://docs.railway.com/networking/public-networking/specs-and-limits). Recheck those pages when changing the deployment boundary.

## Create a fresh project

The prior Railway project has been retired. These instructions assume no existing Railway project, database, service, environment, migration, or deployment.

1. Create one new Railway project with isolated `test` and `prod` environments.
2. In each environment, add a Railway PostgreSQL service, a web service from this repository, and a worker service from this repository.
3. Set the web service's config-as-code path to `/railway.web.toml`; set the worker's to `/railway.worker.toml`.
4. Confirm the web build uses `Dockerfile.web` and the worker build uses `Dockerfile.worker`.
5. Add `DATABASE_URL` to both app services as a private reference to the environment's PostgreSQL `DATABASE_URL`. Do not paste the public TCP proxy URL into any service variable. Maintainer commands that must reach the database from outside Railway read `DATABASE_PUBLIC_URL` from the PostgreSQL service transiently instead; see [`docs/operations/removals.md`](../operations/removals.md).
6. Generate public domains for web and worker. The worker domain exists only so the scheduled live smoke can read `/health`, `/ready`, and the aggregate `/probe`; do not add application routes to it. Do not expose PostgreSQL publicly.
7. Configure both services to deploy `main` in `test` and `prod` in `prod`. Disable direct production deploys from feature branches. Do not migrate or reuse resources from the retired project.

The checked-in service configs use Railway watch patterns to avoid deploying an
unaffected service. An application-source edit confined to `apps/web/` deploys
only the web service; one confined to `apps/worker/` deploys only the worker.
Changes to a shared runtime package, migrations, workspace dependency inputs
(including either app's package manifest), or a service's Dockerfile/config
deploy every service that consumes that input.

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
OPERATOR_SESSION_HASH_SECRET=<distinct value, at least 32 random characters>
OPERATOR_ORIGIN=https://<exact public web hostname>
ANONYMOUS_SEARCHES_PER_HOUR=10
BOT_SEARCHES_PER_HOUR=60
PUBLIC_READS_PER_MINUTE=300
FRESHNESS_HOURS=24
DOSSIER_RAIDERIO_TIER_CAP=8
DOSSIER_CHARACTER_CAP=12
DOSSIER_WARCRAFT_LOGS_REQUEST_CAP=80
DOSSIER_INITIAL_WARCRAFT_LOGS_REQUEST_CAP=20
DOSSIER_INITIAL_WARCRAFT_LOGS_TIMEOUT_MS=8000
# Shared between web and worker: how long a failed upstream lookup is
# remembered. One operational limit with one definition, so it must be
# identical in both services. Defaults to 300000 milliseconds (5 minutes).
NEGATIVE_CACHE_TTL_MS=300000
# Optional secret, shared in purpose with the worker but set per service:
# raises our Raider.IO rate limit above the anonymous allowance. Omit it to
# call Raider.IO anonymously.
RAIDER_IO_ACCESS_KEY=<Raider.IO API key>
# Shared between web and worker: encrypts a visitor-supplied WarcraftLogs key
# while its evidence job is queued. Must be identical in both services.
# 64 hex characters (32 bytes). Generate with: openssl rand -hex 32
EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY=<64 hex characters, identical to the worker's value>
```

The web service never receives the server's own Warcraft Logs credentials —
those stay worker-only and never reach the web service. It does receive a
visitor's own WCL client ID and secret, as request headers on a dossier read,
but encrypts that pair immediately and never persists it in plaintext; only
the ciphertext is written to a queued evidence run for the worker to decrypt.

`OPERATOR_ORIGIN` is the exact public HTTPS origin for browser operator
authentication, with no trailing slash, path, query, or user information.
Sign-in and sign-out require JSON POST, an exactly matching `Origin`, and
`Sec-Fetch-Site: same-origin`. Local browser testing must also use HTTPS;
cookies retain `__Host-`, `Secure`, `HttpOnly`, `Path=/`, and `SameSite=Strict`.
The session cookie renews a 30-minute idle deadline up to an eight-hour
absolute deadline. Authentication responses must use `Cache-Control: no-store`.

`OPERATOR_SESSION_HASH_SECRET` is a web-only Railway secret, separate from
`BOT_API_KEY` and `RATE_LIMIT_HASH_SECRET`. Rotating it invalidates all browser
sessions without changing operator credentials. `BOT_API_KEY` remains an
automation Bearer credential and must not be entered into the browser login.
Operator login throttling trusts only Railway's `X-Real-IP`; missing or invalid
values share a separately bounded global bucket. Forwarded-IP headers are not
accepted as substitutes.

Worker variables. `DISCOVERY_REQUEST_CAP` and the Blizzard fingerprint settings
are read only by the worker, so set them on the worker service alone.
`BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET` must be Railway secret
variables. The fingerprint budget defaults shown below are the application
defaults and can be omitted after the required credentials and sweep cap are
configured:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
DISCOVERY_REQUEST_CAP=40
# Shared with the web service above; keep the two values identical.
NEGATIVE_CACHE_TTL_MS=300000
RAIDER_IO_BASE_URL=https://raider.io
RAIDER_IO_TIMEOUT_MS=10000
# Optional secret: raises our Raider.IO rate limit above the anonymous
# allowance. The discovery sweep is the heaviest Raider.IO consumer, so this
# is the service that benefits most. Omit it to call Raider.IO anonymously.
RAIDER_IO_ACCESS_KEY=<Raider.IO API key>
# Optional secret: announces each discovery run to a Discord channel as it
# starts, once per execution, and each evidence run twice — as it starts and
# again on its outcome, carrying any limitation codes and the Warcraft Logs
# points it spent. Worker-only, because runs execute here. The URL is a
# credential in full. Omit it to announce nothing.
DISCOVERY_WEBHOOK_URL=<Discord webhook URL>
DATABASE_STARTUP_ATTEMPTS=5
DATABASE_STARTUP_RETRY_MS=1000
WORKER_DRAIN_TIMEOUT_MS=30000
# How much of the drain budget a still-running job may spend finishing before
# its signal is aborted. Observed evidence runs take 199-591 seconds, so none
# of them can finish inside the drain budget; aborting is what lets the handler
# release the run instead of dying with it left `running`. Capped at half the
# drain budget, because the release needs the remainder. 0 aborts at once.
WORKER_ABORT_GRACE_MS=5000
WORKER_HEALTH_HOST=0.0.0.0
BLIZZARD_CLIENT_ID=<Blizzard OAuth client ID secret>
BLIZZARD_CLIENT_SECRET=<Blizzard OAuth client secret>
WARCRAFT_LOGS_CLIENT_ID=<Warcraft Logs OAuth client ID secret>
WARCRAFT_LOGS_CLIENT_SECRET=<Warcraft Logs OAuth client secret>
# Shared between web and worker: decrypts a visitor-supplied WarcraftLogs key
# while its evidence job runs. Must be identical in both services.
# 64 hex characters (32 bytes). Generate with: openssl rand -hex 32
EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY=<64 hex characters, identical to the web service's value>
# A ceiling on the pages of report history one run may scan, not the value a
# run receives: the worker scales it to the allowance the run's credentials
# report, and to whose credentials they are. At 18000 the effective cap is 300;
# a visitor's 3600 account gets 18.
EVIDENCE_REQUEST_CAP=500
# Per-cycle cap, not a per-guild limit: a sweep that reaches it resumes from a
# stored cursor on a follow-up cycle until the roster is exhausted. Known
# limitation: a continued cycle does not re-apply the first cycle's
# tournament-profile exclusions, so a later cycle can re-introduce a tournament
# character the first cycle filtered out.
BLIZZARD_SWEEP_REQUEST_CAP=300
BLIZZARD_HOURLY_REQUEST_BUDGET=28800
FINGERPRINT_MINIMUM_COMMON=200
FINGERPRINT_MINIMUM_IDENTICAL_PERCENT=20
FINGERPRINT_SWEEP_CADENCE_HOURS=168
```

`RAIDER_IO_ACCESS_KEY` is optional in both services and must be a Railway
secret variable where it is set. When present it is sent as the `access_key`
query parameter on official `/api/v1/*` requests, where it raises our
rate-limit headroom. Raider.IO's unofficial character-page endpoints reject
the parameter and are always called anonymously. When the key is absent, both
services call Raider.IO anonymously exactly as before, which is the supported
configuration for local development and for contributors without a key.
Setting it in one service and not the other is valid — each service uses its
own value. On the web service it is only the fallback: a visitor who supplies
their own key in the
`x-raiderio-access-key` header spends their own budget instead, and their key
takes precedence for that request.

`MAINTAINER_ALERT_WEBHOOK_URL` is optional and worker-only. Set it as a secret
variable to receive the internal budget and admission-pressure alerts; leave it
unset to keep those alerts in the logs alone. Its path and query string carry
the shared secret for most providers, so configure the complete URL — it is
used exactly as given. Delivery is best effort: a rejected or unresponsive
webhook is logged as `maintainer_alert_delivery_failed` and never fails the
sweep that raised it.

Railway currently documents `X-Real-IP` as the single remote-client header supplied by its public proxy. SlashWho intentionally accepts only that header for anonymous rate-limit identity and fails closed when it is absent or invalid; it does not trust an arbitrary forwarded chain or a runtime-selectable header name. Verify this exact contract against Railway's public-networking documentation before first launch and after any proxy change.

## Health, readiness, and restarts

- Web `/health` is process-only. Web `/ready` runs the shared migrations during container initialization and then verifies PostgreSQL connectivity.
- Worker `/health` is process-only. Worker `/ready` requires PostgreSQL and a started pg-boss queue/consumer.
- Worker `/probe` is read-only and reports only readiness, the age of the last successful discovery run, and aggregate queue depth. It contains no character, guild, run-id, credential, provenance, or fingerprint material.
- Both Railway configs gate deployment on `/ready` and restart failed processes up to ten times.
- Worker draining is 35 seconds, longer than the default 30-second job drain, so graceful shutdown gets the full settlement window.

The scheduled GitHub live smoke reads the worker domain from the repository variable `SLASHWHO_PRODUCTION_WORKER_URL`. Its checked-in 48-hour successful-run threshold tolerates one delayed daily run while still failing when the worker stops completing work. The probe is asserted before the smoke submits the configured dossier character; a fresh dossier is reported as `skipped/inconclusive` for the job path rather than as worker coverage.

After each staging deploy, verify `/health`, `/ready`, one new search, one stale refresh, one immutable historical snapshot, rate limiting, a suppressed character, and a graceful worker restart. For the new cold search, confirm that submitted-character evidence and `Linked-character research is still running; this evidence covers only the submitted character.` appear before linked-character discovery finishes. Also open a character with stored evidence but no current discovery snapshot and confirm `Linked-character research is pending; stored evidence is shown only for the submitted character.` appears immediately. Release discovery and confirm `Linked-character research is complete.` replaces either pending state. In `test`, temporarily use a deliberately bounded fingerprint sweep to exercise a capped run and confirm `Additional linked characters may exist; this dossier is not exhaustive.` appears, then confirm that the continuation cycles run without operator action and the message becomes `Linked-character research is complete.` once the roster is exhausted. Restore the normal test budget afterwards. Promote only the validated `main` commit by fast-forwarding `prod`.

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
