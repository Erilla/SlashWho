# Issue #762: throttle connected-character exclusions and removals

## Goal and evidence

PATCH and DELETE on the connected-characters route currently mutate shared
dossier state without classifying or throttling the caller. POST already passes
headers into search admission. Exclusions are shared by every dossier viewer.
Choose caller throttling rather than retaining unlimited anonymous writes.

## Proposed policy

- Keep anonymous editing available. Use the existing `classifyCaller` rules:
  anonymous callers require the trusted `x-real-ip` header; a presented bearer
  token must pass the existing bot credential check. Missing or invalid trusted
  identity fails closed with the existing safe public error.
- PATCH and DELETE share a `connection-mutation:<caller HMAC>` bucket across
  all dossiers and targets. Switching method or dossier does not reset it.
  Persist only the keyed HMAC and the operation prefix, never raw IPs, tokens
  or request URLs.
- Reserve atomically through the existing rate-limit repository, using a
  one-hour window and the existing `ANONYMOUS_SEARCHES_PER_HOUR` or
  `BOT_SEARCHES_PER_HOUR` setting for the classified caller. The anonymous
  default is 10/hour. The dedicated bucket avoids an edit consuming a discovery
  search allowance; no new configuration or database migration is needed.
- Check canonical route parameters and body schema first, then reserve before
  invoking either dossier mutation. Every admitted valid-body attempt consumes
  an allowance, including attempts whose target is subsequently missing or
  invalid. A denied reservation changes no connection state.
- Return the existing safe `rate_limited` HTTP 429 with a positive
  `Retry-After` and `Cache-Control: no-store`. Preserve successful responses and
  existing invalid/missing-target responses.
- POST retains its existing search admission. This change bounds the two
  unthrottled routes; it does not introduce account ownership or authorisation
  for shared connections.

## Implementation and regressions

1. Add `reserveConnectionMutation` to the application rate limiter and
   `authorizeConnectionMutation(headers, scope)` to SearchService, following
   the existing tier-search admission pattern. Use measured repositories when
   a request scope is supplied.
2. Pass the request headers and scope from PATCH and DELETE through that
   admission method and stop before calling the dossier service on refusal.
   Reuse the existing admission-response mapping.
3. Write tests first for both routes' header/scope forwarding, 429/retry header,
   no mutation on refusal, missing trusted identity and invalid credentials.
   Cover both include and exclude behaviour and preserve existing 400/404
   handling. Test the application admission with actual caller classification
   and the rate limiter: shared method bucket, caller separation, configured
   anonymous/bot limits, expiry, and HMAC-only repository arguments. Exercise
   real repository reservation behaviour where the existing integration
   fixtures support it, including refusal without mutation.
4. Document the anonymous shared-edit policy and allowance where the existing
   endpoint/rate-limit documentation describes caller admission.

## Validation and delivery

After manager approval, install the frozen dependencies and prepare `.env`.
Observe the new regression tests fail before implementation. Run the full gate
with Docker: format:check, lint, typecheck, test:unit, test:integration, build,
test:e2e. Review against origin/main, fetch and merge the latest trunk, then
repeat the required gate. Turn this draft into the implementation PR, watch CI
and review comments, and address findings. Never merge or enable auto-merge.

## Review requested

Please confirm the shared PATCH/DELETE bucket and reuse of the existing
per-hour search limits in a separate mutation namespace. Implementation waits
for manager approval under issue-pickup.
