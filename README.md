# SlashWho

SlashWho is a public website and versioned API for finding possible World of Warcraft alt characters from a Raider.IO character URL.

```text
https://raider.io/characters/eu/silvermoon/Ryii
```

It extends the alt-discovery work from [Erilla/SeriouslyCasualBotV2](https://github.com/Erilla/SeriouslyCasualBotV2) so the website and bot can share one durable API.

## Architecture

SlashWho is a Node.js 22/pnpm TypeScript workspace:

- `apps/web` — Next.js website and thin `/api/v1` route adapters.
- `apps/worker` — durable pg-boss discovery worker and readiness server.
- `packages/application` — authentication, freshness, rate-limit, and use-case orchestration.
- `packages/domain` — canonical character identity and pure bounded discovery.
- `packages/raiderio` — sanitized Raider.IO gateway.
- `packages/database` — PostgreSQL repositories, Drizzle migrations, and queue ownership.
- `packages/contracts` — strict public request/response schemas shared with bot clients.

Successful refreshes are immutable. PostgreSQL atomically publishes the newest snapshot only after its full membership is committed. The service never stores BattleTags, Discord handles, raw client IPs, API keys, guess strings, raw Raider.IO responses, or raw request URLs.

## Local setup

Prerequisites: Node.js 22.12–22.x, Corepack, Docker, and a Docker-capable PostgreSQL 16 environment. Integration and E2E tests use Testcontainers, so Docker must be running.

```bash
corepack enable
corepack pnpm install --frozen-lockfile
cp .env.example .env
docker run --name slashwho-postgres -e POSTGRES_USER=slashwho -e POSTGRES_PASSWORD=slashwho -e POSTGRES_DB=slashwho -p 5432:5432 postgres:16-alpine
corepack pnpm dev
```

Generate new values of at least 32 random characters for `BOT_API_KEY` and `RATE_LIMIT_HASH_SECRET`; do not use the example values outside local development. The web app defaults to port 3000 and the worker health server to port 3001.

## Development commands

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm test:integration
corepack pnpm build
corepack pnpm playwright test
```

| Test layer  | Boundary                                                                           |
| ----------- | ---------------------------------------------------------------------------------- |
| Unit        | Pure domain, contracts, serializers, HTTP mapping, runtime lifecycle               |
| Integration | Real PostgreSQL migrations, repositories, queue, policy, atomic snapshots          |
| Browser     | Real PostgreSQL, real worker, Next.js, and a deterministic local Raider.IO fixture |
| Live smoke  | Scheduled/manual production health and one real search; never gates pull requests  |

Live Raider.IO traffic is never part of the pull-request gate. Automated discovery tests use sanitized recorded or local fixtures.

## API, privacy, and operations

The running site serves the API reference at `/api` and privacy policy at `/privacy`. Bot compatibility examples are locked in [`tests/fixtures/contracts/bot-client-v1.json`](tests/fixtures/contracts/bot-client-v1.json). Removal requests use the [public issue template](.github/ISSUE_TEMPLATE/removal-request.yml); maintainer procedure is in [`docs/operations/removals.md`](docs/operations/removals.md).

Railway setup, variables, health checks, backups, and validation are documented in [`docs/deployment/railway.md`](docs/deployment/railway.md). `main` deploys to the `test` environment. Production is promoted only by fast-forwarding the staging-validated commit to `prod`.

## Repository guidance

- Agent instructions: [`AGENTS.md`](AGENTS.md)
- Contribution and branch workflow: [`docs/contributing.md`](docs/contributing.md)
- Issue-tracker conventions: [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)
- Triage labels: [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)
- Domain-document conventions: [`docs/agents/domain.md`](docs/agents/domain.md)

SlashWho is available under the [MIT License](LICENSE).
