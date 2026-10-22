import {
  AuthenticationError,
  classifyCaller,
  type ApplicationConfig,
  type CallerIdentity
} from "@slashwho/application";

import { apiError } from "./http";

export type BotAuthorization =
  { identity: CallerIdentity } | { refusal: Response };

/**
 * The bot routes are Bearer-only. A missing header would otherwise fall through
 * to the anonymous client-IP path, so every failure is `401 unauthorized`
 * rather than a trusted-IP refusal or an anonymous identity.
 */
export function requireBot(
  headers: Pick<Headers, "get">,
  config: ApplicationConfig
): BotAuthorization {
  let identity: CallerIdentity;
  try {
    identity = classifyCaller(headers, config);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return { refusal: apiError("unauthorized") };
    }
    throw error;
  }
  if (identity.callerClass !== "bot") {
    return { refusal: apiError("unauthorized") };
  }
  return { identity };
}
