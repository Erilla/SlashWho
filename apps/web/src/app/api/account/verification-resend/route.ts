import { getContainer } from "../../../../server/container";
import {
  accountFailure,
  accountMutation,
  accountReply
} from "../../../../server/account-http";
import { canonicalizeEmail } from "../../../../server/account-email";
import { withHttpRequest } from "../../../../server/http";

export async function POST(request: Request): Promise<Response> {
  return withHttpRequest("account_verification_resend", async () => {
    const { accountOrigin, accountTokens } = await getContainer();
    const body = await accountMutation(request, accountOrigin);
    const email =
      typeof body?.email === "string" ? canonicalizeEmail(body.email) : null;
    if (!email) return accountFailure("Enter a valid email address.");
    if (!accountTokens)
      return accountFailure("Account email is not configured.", 503);
    // The token service applies the same per-address daily verification cap.
    await accountTokens.resendVerification(email, new Date());
    return accountReply(
      "If this address needs verification, check your email.",
      202
    );
  });
}
