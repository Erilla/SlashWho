import { getContainer } from "../../../../server/container";
import { withHttpRequest } from "../../../../server/http";

export async function GET(request: Request): Promise<Response> {
  return withHttpRequest("account_session", async (scope) => {
    const { principal, cookie } = await (
      await getContainer()
    ).accountAuth.authenticate(request, scope);
    const response = Response.json(
      {
        account:
          principal?.kind === "account"
            ? {
                email: principal.email,
                role: principal.role,
                passwordChangeRequired: principal.passwordChangeRequired
              }
            : null
      },
      { headers: { "cache-control": "no-store" } }
    );
    if (cookie) response.headers.set("set-cookie", cookie.header);
    return response;
  });
}
