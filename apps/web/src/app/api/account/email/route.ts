import { getContainer } from "../../../../server/container";
import {
  accountFailure,
  accountMutation,
  accountReply
} from "../../../../server/account-http";
import { withHttpRequest } from "../../../../server/http";

export async function POST(request: Request): Promise<Response> {
  return withHttpRequest("account_email", async () => {
    const { accountOrigin, accountTokens, accountAuth } = await getContainer();
    const body = await accountMutation(request, accountOrigin);
    if (!body) return accountFailure("Invalid request.");
    if (!accountTokens)
      return accountFailure("Account email is not configured.", 503);
    if (typeof body.token === "string") {
      const result = await accountTokens.confirmEmailChange(
        body.token,
        new Date()
      );
      return result === "invalid"
        ? accountFailure("This email change link is invalid or expired.")
        : accountReply(
            result === "changed"
              ? "Email changed. Sign in again."
              : "Approval saved. The other address must also confirm."
          );
    }
    const { principal } = await accountAuth.authenticate(request);
    if (principal?.kind !== "account" || principal.passwordChangeRequired)
      return accountFailure("Sign in to change your email.", 401);
    if (typeof body.password !== "string" || typeof body.newEmail !== "string")
      return accountFailure("Invalid request.");
    await accountTokens.requestEmailChange(
      principal.accountId,
      body.password,
      body.newEmail,
      new Date()
    );
    return accountReply(
      "If the request is valid, both addresses will receive confirmation links.",
      202
    );
  });
}
