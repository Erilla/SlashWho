import { getContainer } from "../../../../server/container";
import { apiError, withHttpRequest } from "../../../../server/http";

export async function POST(request: Request): Promise<Response> {
  return withHttpRequest("operator_session_login", async () => {
    const { accountAuth } = await getContainer();
    const result = await accountAuth.signIn(request);
    if (!result.principal) return apiError("unauthorized");
    return new Response(null, {
      status: 204,
      headers: {
        "cache-control": "no-store",
        "x-password-change-required":
          result.principal.kind === "account" &&
          result.principal.passwordChangeRequired
            ? "1"
            : "0",
        ...(result.cookie ? { "set-cookie": result.cookie.header } : {})
      }
    });
  });
}
