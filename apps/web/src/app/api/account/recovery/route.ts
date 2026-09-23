import { getContainer } from "../../../../server/container";
import {
  accountFailure,
  accountMutation,
  accountReply
} from "../../../../server/account-http";
import { canonicalizeEmail } from "../../../../server/account-email";
import { withHttpRequest } from "../../../../server/http";

export async function POST(request: Request): Promise<Response> {
  return withHttpRequest("account_recovery", async () => {
    const { accountOrigin, accountTokens } = await getContainer();
    const body = await accountMutation(request, accountOrigin);
    if (!body) return accountFailure("Invalid request.");
    if (!accountTokens)
      return accountFailure(
        "Account email is not configured. Please try again later.",
        503
      );
    const email =
      typeof body.email === "string" ? canonicalizeEmail(body.email) : null;
    if (!email) return accountFailure("Enter a valid email address.");
    await accountTokens.requestReset(email, new Date());
    return accountReply(
      "If this address has an account, check your email for a recovery link.",
      202
    );
  });
}
