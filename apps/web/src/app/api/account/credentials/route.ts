import { getContainer } from "../../../../server/container";
import {
  accountFailure,
  accountMutation
} from "../../../../server/account-http";
import {
  validProvider,
  validValues
} from "../../../../server/account-credentials";
import { authorizes } from "../../../../server/operator-auth";
import { withHttpRequest } from "../../../../server/http";

async function principalFor(request: Request) {
  const container = await getContainer();
  const authentication = await container.accountAuth.authenticate(request);
  const principal = authentication.principal;
  return {
    container,
    accountId:
      authorizes(principal, "account") && principal?.kind === "account"
        ? principal.accountId
        : null,
    cookie: authentication.cookie
  };
}

export async function GET(request: Request): Promise<Response> {
  return withHttpRequest("account_credentials_get", async () => {
    const { container, accountId, cookie } = await principalFor(request);
    if (!accountId) return accountFailure("Sign in required.", 401);
    if (!container.accountCredentials)
      return accountFailure("Account credentials are unavailable.", 503);
    const response = Response.json(
      { providers: await container.accountCredentials.summary(accountId) },
      { headers: { "cache-control": "no-store" } }
    );
    if (cookie) response.headers.set("set-cookie", cookie.header);
    return response;
  });
}

export async function PUT(request: Request): Promise<Response> {
  return withHttpRequest("account_credentials_put", async () => {
    const { container, accountId } = await principalFor(request);
    if (!accountId) return accountFailure("Sign in required.", 401);
    const body = await accountMutation(request, container.accountOrigin, "PUT");
    if (
      !body ||
      !validProvider(body.provider) ||
      !validValues(body.provider, body.values) ||
      typeof body.replace !== "boolean" ||
      !Number.isSafeInteger(body.expectedVersion) ||
      (body.expectedVersion as number) < 0
    )
      return accountFailure("Invalid credentials request.");
    if (!container.accountCredentials)
      return accountFailure("Account credentials are unavailable.", 503);
    const summary = await container.accountCredentials.summary(accountId);
    const slot = summary.find((item) => item.provider === body.provider)!;
    if (slot.present && !body.replace)
      return accountFailure("Credential already saved. Choose replace.", 409);
    if (slot.version !== body.expectedVersion)
      return accountFailure("Credential changed. Refresh and try again.", 409);
    const result = await container.accountCredentials.replace(
      accountId,
      body.provider,
      body.values,
      body.expectedVersion as number
    );
    return result === "saved"
      ? Response.json(
          { provider: body.provider, saved: true },
          { headers: { "cache-control": "no-store" } }
        )
      : accountFailure("Credential changed. Refresh and try again.", 409);
  });
}

export async function DELETE(request: Request): Promise<Response> {
  return withHttpRequest("account_credentials_delete", async () => {
    const { container, accountId } = await principalFor(request);
    if (!accountId) return accountFailure("Sign in required.", 401);
    const body = await accountMutation(
      request,
      container.accountOrigin,
      "DELETE"
    );
    if (
      !body ||
      !validProvider(body.provider) ||
      !Number.isSafeInteger(body.expectedVersion) ||
      (body.expectedVersion as number) < 1
    )
      return accountFailure("Invalid credentials request.");
    if (!container.accountCredentials)
      return accountFailure("Account credentials are unavailable.", 503);
    const removed = await container.accountCredentials.remove(
      accountId,
      body.provider,
      body.expectedVersion as number
    );
    if (!removed)
      return accountFailure("Credential changed. Refresh and try again.", 409);
    return Response.json(
      { provider: body.provider, removed: true },
      { headers: { "cache-control": "no-store" } }
    );
  });
}
