# SlashWho

SlashWho is an unlisted, unauthenticated guild tool for researching a World of Warcraft applicant from a Raider.IO or Warcraft Logs character URL.

```text
https://raider.io/characters/eu/silvermoon/Ryii
```

It extends the alt-discovery work from [Erilla/SeriouslyCasualBotV2](https://github.com/Erilla/SeriouslyCasualBotV2) so the website and bot can share one durable API.

## Architecture

SlashWho is a Node.js 22/pnpm TypeScript workspace:

- `apps/web` — Next.js applicant-dossier interface and its server-side adapters.
- `apps/worker` — durable pg-boss discovery worker and readiness server.
- `packages/application` — authentication, freshness, rate-limit, and use-case orchestration.
- `packages/domain` — canonical character identity and pure bounded discovery.
- `packages/raiderio` — sanitized Raider.IO gateway.
- `packages/database` — PostgreSQL repositories, Drizzle migrations, and queue ownership.
- `packages/contracts` — strict request/response schemas shared by the application.

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

## Warcraft Logs parse evidence

Historic Mythic kill evidence can include damage, healing, and boss-damage
percentiles. SlashWho queries `Report.rankings` with `compare: Rankings` and
`timeframe: Historical`, scoped to the exact report, fight, encounter, Mythic
difficulty, region, realm, and canonical character. A ranking-row character ID
is resolved through the canonical `Character(id)` lookup and then matched to a
unique Player actor; a name-only match is never enough. Available values link
to the exact supporting fight.

The dossier shows **First kill parses** for the earliest displayed kill event,
and **Best parses** for the character's best on that boss. The two rows answer
different questions and are fetched differently. A first-kill parse must come
from that exact fight, so it is read from report rankings. A best parse is a
claim about the character, so it is read from `zoneRankings` — one request per
raid zone, covering every encounter in it, rather than one request per report
of an unbounded history. A best parse may therefore come from a kill outside
the raid's current-content window, which the dossier does not list; it links to
the character's own rankings rather than to a fight, and it is never written
onto a first-kill parse. An available numeric `0` is a
legitimate provider result. `unavailable` means the value could not safely be
obtained; `not_applicable` is reserved for independently established role
inapplicability. Neither state is presented as numeric zero, and a partial
parse result never removes verified kill evidence.

Percentile labels also use the seven Warcraft Logs/RPGLogs bands (grey
`#666666`, green `#1eff00`, blue `#0070ff`, purple `#a335ee`, orange
`#ff8000`, pink `#e268a8`, and gold `#e5cc80`); text and accessible labels
always carry the metric meaning as well as colour.

## Operations

This is not a public API, searchable directory, or historical character archive. Dossiers are assembled for the current browser request and may contain incomplete source evidence. The assembled response is always `Cache-Control: no-store`; reusable per-character evidence is separately cached in normalized form only. Maintainers retain the internal snapshot and suppression process in [`docs/operations/removals.md`](docs/operations/removals.md).

Railway setup, variables, health checks, backups, and validation are documented in [`docs/deployment/railway.md`](docs/deployment/railway.md). `main` deploys to the `test` environment. Production is promoted only by fast-forwarding the staging-validated commit to `prod`.

## Repository guidance

- Agent instructions: [`AGENTS.md`](AGENTS.md)
- Contribution and branch workflow: [`docs/contributing.md`](docs/contributing.md)
- Implementation and worktree workflow: [`docs/agents/implementation-workflow.md`](docs/agents/implementation-workflow.md)
- Issue-tracker conventions: [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)
- Triage labels: [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)
- Domain-document conventions: [`docs/agents/domain.md`](docs/agents/domain.md)

SlashWho is available under the [MIT License](LICENSE).
