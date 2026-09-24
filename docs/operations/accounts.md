# Account rollout

## Before deployment

1. Back up PostgreSQL and record the current deployed commit. The account migration **deletes all legacy operator identities and sessions**. Former operators cannot sign in afterward. Authentication events retain their action and timestamp with the old identity reference cleared; public search, dossiers, evidence, and other public data remain. `BOT_API_KEY` bearer automation continues to work, including monitor API access.
2. In Resend, verify the domain used by `ACCOUNT_EMAIL_FROM`. Set `RESEND_API_KEY` and `ACCOUNT_EMAIL_FROM` in both web and worker deployment variables. The sender must belong to that verified domain. Keep `OPERATOR_ORIGIN` set to the exact HTTPS public origin so email links point to the deployed site.
3. Generate a distinct 32-byte key (`openssl rand -hex 32`) for `ACCOUNT_CREDENTIAL_ENCRYPTION_KEY`. Set the **same** 64-character hex value in web and worker. Keep it separate from `EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY`, and retain it for restores. It encrypts saved provider keys and, through independent key derivation, queued account mail. Changing it without a data migration makes those records unreadable.
4. Retain `OPERATOR_SESSION_HASH_SECRET` and `RATE_LIMIT_HASH_SECRET` as distinct strong values. Retain `BOT_API_KEY` for existing automation.

## Deploy and bootstrap

Deploy the migration and new web/worker code together. There is no admin until the first account is provisioned; public searches and dossiers stay available during that interval. From a terminal with `DATABASE_URL` pointed at the migrated database, run:

```sh
corepack pnpm ops:operators -- provision-admin owner@example.com
```

The CLI requires an interactive TTY and prompts for a **hidden temporary password** of at least 6 characters. Do not place it on the command line, in environment variables, or in logs. The admin is already email verified and must sign in with the temporary password, change it on the required password-change page, then sign in again. Confirm `/admin/settings` and the collection monitor load for that account. Web registration creates ordinary users only.

## Validate after rollout

- Search for a character and open a dossier while signed out. Public search, dossier reads, evidence collection, controls, rate limits, and allowance policy still work without registration.
- Register a test account, follow its verification link, and sign in. Exercise recovery and a saved key import if migrating a browser-stored key. A saved account key is never returned as a secret; signed-out browser keys continue to work.
- Confirm an ordinary account is denied admin settings and monitor access. Confirm a valid `BOT_API_KEY` can still call the monitor API.
- Check worker mail-delivery logs for failures without exposing tokens or addresses. Account mail uses durable encrypted outbox messages and stable idempotency keys for retries.

Without Resend configuration or while mail delivery is unavailable, new registration verification, recovery, and email-change delivery cannot complete. This affects account flows only; existing public features and bearer automation remain available. Restore mail configuration and retry the account action after delivery recovers.

## Email-change admission

Each accepted email-change request queues two approval messages. Issuance is
limited to five requests per requesting account per hour, three per canonical
destination per day, and 100 requests globally per hour (at most 200 queued
messages). PostgreSQL admits all three buckets atomically with both token and
outbox pairs. The destination bucket stores a purpose-specific HMAC, never the
address. Limits expire exactly one hour or day after each admitted request.
Rejected requests leave existing approvals intact, queue no mail, and return
the same generic acknowledgement as other validly shaped requests.
