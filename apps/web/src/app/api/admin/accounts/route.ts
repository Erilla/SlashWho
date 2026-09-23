import { getContainer } from "../../../../server/container";
import { authorizes } from "../../../../server/operator-auth";
import { withHttpRequest } from "../../../../server/http";

export async function GET(request: Request): Promise<Response> {
  return withHttpRequest("admin_accounts", async () => {
    const { accountAuth, accountAdmin } = await getContainer();
    const authentication = await accountAuth.authenticate(request);
    const headers = new Headers({ "cache-control": "no-store" });
    if (authentication.cookie)
      headers.set("set-cookie", authentication.cookie.header);
    if (
      !authorizes(authentication.principal, "admin") ||
      authentication.principal?.kind !== "account"
    )
      return Response.json({ error: "forbidden" }, { status: 403, headers });
    const accounts = await accountAdmin.listAccounts(
      authentication.principal.accountId
    );
    return Response.json(
      accounts.map(({ id, email, role, active, verifiedAt, createdAt }) => ({
        id,
        email,
        role,
        active,
        verifiedAt,
        createdAt
      })),
      { headers }
    );
  });
}
