import { getContainer } from "../../../../server/container";
import {
  accountFailure,
  accountMutation,
  accountReply
} from "../../../../server/account-http";
import {
  canonicalizeEmail,
  registrationSubjects
} from "../../../../server/account-email";
import { hashOperatorCredential } from "../../../../server/operator-auth";
import { withHttpRequest } from "../../../../server/http";

export async function POST(request: Request): Promise<Response> {
  return withHttpRequest("account_register", async () => {
    const container = await getContainer();
    const body = await accountMutation(request, container.accountOrigin);
    if (!body) return accountFailure("Invalid request.");
    if (!container.accountTokens)
      return accountFailure(
        "Account email is not configured. Please try again later.",
        503
      );
    const email =
      typeof body.email === "string" ? canonicalizeEmail(body.email) : null;
    const password = body.password;
    if (
      !email ||
      typeof password !== "string" ||
      password.length < 6 ||
      password.length > 1024
    )
      return accountFailure(
        "Enter a valid email and a password of at least 6 characters."
      );
    const at = new Date();
    const admitted = await container.accountRegistration.admitRegistration({
      ...registrationSubjects(request, email, container.registrationHashSecret),
      at
    });
    if (admitted === "throttled")
      return accountFailure("Too many requests. Try again later.", 429);
    const hashed = await hashOperatorCredential(password);
    const result = await container.accountRegistration.registerPending({
      canonicalEmail: email,
      email,
      ...hashed,
      at
    });
    if (result.kind === "created" && result.accountId)
      await container.accountTokens.issueVerification(
        result.accountId,
        at,
        true
      );
    return accountReply(
      "If this address can be registered, check your email for a verification link.",
      202
    );
  });
}
