import { getContainer } from "../../../../server/container";
import { apiError, withHttpRequest } from "../../../../server/http";

export async function POST(request: Request): Promise<Response> {
  return withHttpRequest("operator_session_login", async () => {
    const { operatorAuth } = await getContainer();
    const result = await operatorAuth.signIn(request);
    if (!result.principal) return apiError("unauthorized");
    return new Response(null, {
      status: 204,
      headers: {
        "cache-control": "no-store",
        ...(result.cookie ? { "set-cookie": result.cookie.header } : {})
      }
    });
  });
}
