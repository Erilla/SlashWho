import { getContainer } from "../../../../server/container";
import {
  accountFailure,
  accountMutation,
  accountReply
} from "../../../../server/account-http";
import { withHttpRequest } from "../../../../server/http";

export async function POST(request: Request): Promise<Response> {
  return withHttpRequest("account_password", async () => {
    const { accountOrigin, accountTokens, accountAuth } = await getContainer();
    const body = await accountMutation(request.clone(), accountOrigin);
    if (!body) return accountFailure("Invalid request.");
    if (typeof body.token === "string") {
      if (
        typeof body.newPassword !== "string" ||
        body.newPassword.length < 6 ||
        body.newPassword.length > 1024
      )
        return accountFailure("Use a password of at least 6 characters.");
      if (!accountTokens)
        return accountFailure("Account email is not configured.", 503);
      const result = await accountTokens.completeReset(
        body.token,
        body.newPassword,
        new Date()
      );
      return result === "changed"
        ? accountReply("Password changed. Sign in again.")
        : accountFailure("This recovery link is invalid or expired.");
    }
    const result = await accountAuth.changePassword(request);
    return result.accepted
      ? new Response(
          JSON.stringify({ message: "Password changed. Sign in again." }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
              "set-cookie": result.cookie!.header
            }
          }
        )
      : accountFailure("Unable to change password.", 401);
  });
}
