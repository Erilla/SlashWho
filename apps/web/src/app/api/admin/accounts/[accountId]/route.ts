import { accountMutation } from "../../../../../server/account-http";
import { getContainer } from "../../../../../server/container";
import { withHttpRequest } from "../../../../../server/http";
import { authorizes } from "../../../../../server/operator-auth";

type Context = { params: Promise<{ accountId: string }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  context: Context
): Promise<Response> {
  return withHttpRequest("admin_account_mutation", async () => {
    const { accountAuth, accountAdmin, accountOrigin } = await getContainer();
    const authentication = await accountAuth.authenticate(request);
    const headers = new Headers({ "cache-control": "no-store" });
    if (authentication.cookie)
      headers.set("set-cookie", authentication.cookie.header);
    if (
      !authorizes(authentication.principal, "admin") ||
      authentication.principal?.kind !== "account"
    )
      return Response.json({ error: "forbidden" }, { status: 403, headers });
    const { accountId } = await context.params;
    if (!uuid.test(accountId))
      return Response.json(
        { error: "invalid_account" },
        { status: 400, headers }
      );
    const body = await accountMutation(request, accountOrigin);
    if (!body)
      return Response.json(
        { error: "invalid_request" },
        { status: 400, headers }
      );
    const input = {
      actorId: authentication.principal.accountId,
      targetId: accountId,
      at: new Date()
    };
    let result:
      "updated" | "last_admin" | "forbidden" | "missing" | "invalid_request";
    if (
      body.action === "role" &&
      (body.role === "user" || body.role === "admin") &&
      Object.keys(body).length === 2
    )
      result = await accountAdmin.setRole({ ...input, role: body.role });
    else if (
      body.action === "active" &&
      typeof body.active === "boolean" &&
      Object.keys(body).length === 2
    )
      result = await accountAdmin.setActive({ ...input, active: body.active });
    else if (
      body.action === "require_password_change" &&
      Object.keys(body).length === 1
    )
      result = (await accountAdmin.requirePasswordChange(input))
        ? "updated"
        : "missing";
    else result = "invalid_request";
    const status =
      result === "updated"
        ? 200
        : result === "last_admin"
          ? 409
          : result === "missing"
            ? 404
            : result === "forbidden"
              ? 403
              : 400;
    return Response.json(
      result === "updated"
        ? { message: "Account updated." }
        : { error: result },
      { status, headers }
    );
  });
}
