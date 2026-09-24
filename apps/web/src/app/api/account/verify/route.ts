import { getContainer } from "../../../../server/container";
import {
  accountFailure,
  accountMutation,
  accountReply
} from "../../../../server/account-http";
import { withHttpRequest } from "../../../../server/http";

export async function POST(request: Request): Promise<Response> {
  return withHttpRequest("account_verify", async () => {
    const { accountOrigin, accountTokens, accountAuth } = await getContainer();
    const body = await accountMutation(request, accountOrigin);
    if (
      !body ||
      typeof body.token !== "string" ||
      typeof body.password !== "string"
    )
      return accountFailure("Invalid request.");
    if (!accountTokens)
      return accountFailure("Account email is not configured.", 503);
    const result = await accountTokens.confirmVerification(
      body.token,
      body.password,
      new Date()
    );
    if (result === "invalid")
      return accountFailure("This verification link or password is invalid.");
    const signedIn = await accountAuth.signInVerifiedAccount(request, result);
    if (!signedIn.principal || !signedIn.cookie)
      return accountFailure("Email verified. Sign in to continue.", 503);
    const reply = accountReply("Email verified. You are signed in.");
    reply.headers.set("set-cookie", signedIn.cookie.header);
    return reply;
  });
}
