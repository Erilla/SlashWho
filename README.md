# SlashWho

SlashWho is a planned API and website for finding possible World of Warcraft alt characters. A user supplies a Raider.IO character URL, and SlashWho starts from that character to look for other characters that may belong to the same player.

Example input:

```text
https://raider.io/characters/eu/silvermoon/Ryii
```

This project extends the alt-discovery feature originally developed in [Erilla/SeriouslyCasualBotV2](https://github.com/Erilla/SeriouslyCasualBotV2), making the capability available outside the Discord bot through a dedicated website and API.

## Deployment and integration goals

- Deploy the service to Railway.
- Expose the alt-discovery capability through an API used by both the website and external clients.
- Allow SeriouslyCasualBotV2 to consume the API instead of owning a separate implementation.

## Status

The repository is being set up. Detailed product behavior, architecture, technology choices, and operating limits have not yet been finalized.

## Repository guidance

- Agent instructions: [`AGENTS.md`](AGENTS.md)
- Issue-tracker conventions: [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)
- Triage labels: [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md)
- Domain-document conventions: [`docs/agents/domain.md`](docs/agents/domain.md)
