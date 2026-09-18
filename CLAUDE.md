@AGENTS.md

## Working in this repository

- Implementation work follows [`docs/agents/implementation-workflow.md`](docs/agents/implementation-workflow.md): an isolated worktree per change, branched from `origin/main`.
- `pnpm` is reached through Corepack. Always run `corepack pnpm <script>`; a bare `pnpm` is not on `PATH`.
- Contribution and branch conventions are in [`docs/contributing.md`](docs/contributing.md).

## Review criteria

When reviewing a change, treat these as the standards for this repository:

- Successful refreshes are immutable, and PostgreSQL publishes a new snapshot only after its full membership is committed. A change that lets a partial snapshot become visible is a bug.
- The service never stores BattleTags, Discord handles, raw client IPs, API keys, guess strings, raw Raider.IO responses, or raw request URLs. Flag anything that would log or persist them.
- Evidence states are distinct: an available numeric `0` is a legitimate provider result, `unavailable` means the value could not safely be obtained, and `not_applicable` is reserved for established role inapplicability. None of them may be rendered as, or collapsed into, numeric zero.
- A partial parse result never removes verified kill evidence.
- Assembled dossier responses are always `Cache-Control: no-store`.
- Live Raider.IO or Warcraft Logs traffic never belongs in the pull-request gate; tests use sanitized recorded or local fixtures.
