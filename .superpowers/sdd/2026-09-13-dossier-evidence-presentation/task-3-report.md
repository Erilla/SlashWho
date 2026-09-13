# Task 3 report

## Changed files

- Expanded the dossier contract and serialization with class metadata, Raider.IO URLs, and nullable official achievement icons.
- Preserved every distinct Warcraft Logs Mythic fight, coalesced Cutting Edge achievements by ID and earliest completion, and applied canonical newest-tier/final-boss-first ordering.
- Added strict Raider.IO historical-rank enrichment requiring a unique guild name, region, realm/connected-realm, and two-minute timestamp match.
- Extended Raider.IO boss-ranking rows with normalized guild region and wired the web container to use the ranking gateway.

## Verification

- `corepack pnpm vitest run packages/warcraftlogs/src/client.test.ts packages/domain/src/applicant-dossier.test.ts packages/raiderio/src/client.test.ts packages/application/src/applicant-dossier-service.test.ts packages/contracts/src/contracts.test.ts` — 83 passed.
- `corepack pnpm typecheck` — passed.
- `corepack pnpm lint` — passed.
- `corepack pnpm format:check` — passed before the final Warcraft Logs test-first adjustment; both changed Warcraft Logs files were subsequently formatted with Prettier.

## Known limits

- Raider.IO ranks remain unknown for unmapped or unavailable leaderboard bosses, no leaderboard row, and ambiguous or mismatched source data. This is intentional rather than inferring a rank.
- The unrelated `apps/web/next-env.d.ts` working-tree change was left unstaged.
