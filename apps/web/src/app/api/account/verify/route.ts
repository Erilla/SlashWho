import { getContainer } from "../../../../server/container";
import {
  accountFailure,
  accountMutation,
  accountReply
} from "../../../../server/account-http";
import { withHttpRequest } from "../../../../server/http";

export async function POST(request: Request): Promise<Response> {
  return withHttpRequest("account_verify", async () => {
    const { accountOrigin, accountTokens } = await getContainer();
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
    return result === "verified"
      ? accountReply("Email verified. You can sign in.")
      : accountFailure("This verification link or password is invalid.");
  });
}
