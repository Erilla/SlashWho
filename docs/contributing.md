# Contributing

## Branch strategy

- `main` is the trunk and will deploy to the persistent Railway staging environment.
- `prod` represents the version deployed to Railway production.
- Feature branches use `feat/<short-description>`.
- Bug fixes use `fix/<short-description>`.
- Maintenance and documentation use `chore/<short-description>` or `docs/<short-description>`.

Branches should be short-lived and contain one coherent change. There is no `develop` branch.

## Pull-request flow

1. Create a branch from the latest `main`.
2. Make and verify one coherent change.
3. Open a pull request targeting `main`.
4. Resolve review conversations and ensure all required checks pass.
5. Squash-merge the pull request using a conventional title.
6. Validate the resulting `main` deployment in staging.

Use conventional commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, and `chore:`. Add a scope when it makes the affected area clearer, for example `feat(api): add character lookup`.

## Production promotion

Production is promoted only by fast-forwarding `prod` to a commit already validated on `main`:

```bash
git fetch origin
git push origin origin/main:prod
```

Never commit directly to `prod`, merge unrelated work into it, or force-push it. Keep `main` releasable so urgent fixes do not require bypassing staged work.

## Repository automation

GitHub Actions and Railway deployment requirements will be documented once the application stack and service layout are selected. Until then, perform the relevant local verification described by each change.
