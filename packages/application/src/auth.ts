import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { CallerClass } from "@slashwho/database";

import type { ApplicationConfig } from "./config";

export const railwayClientIpHeader = "x-real-ip";

export type CallerIdentity = Readonly<{
  callerClass: CallerClass;
  bucketHash: string;
}>;

export class AuthenticationError extends Error {
  readonly code: "unauthorized" | "trusted_client_ip_unavailable";

  constructor(code: AuthenticationError["code"]) {
    super(code);
    this.name = "AuthenticationError";
    this.code = code;
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function bucketHash(secret: string, identity: string): string {
  return createHmac("sha256", secret).update(identity).digest("hex");
}

export function classifyCaller(
  headers: Pick<Headers, "get">,
  config: ApplicationConfig
): CallerIdentity {
  const authorization = headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer (.+)$/i.exec(authorization);
    const presentedDigest = digest(match?.[1] ?? "");
    const configuredDigest = digest(config.BOT_API_KEY);
    if (
      !match ||
      presentedDigest.length !== configuredDigest.length ||
      !timingSafeEqual(presentedDigest, configuredDigest)
    ) {
      throw new AuthenticationError("unauthorized");
    }

    const stableKeyId = configuredDigest.toString("hex");
    return {
      callerClass: "bot",
      bucketHash: bucketHash(
        config.RATE_LIMIT_HASH_SECRET,
        `bot:${stableKeyId}`
      )
    };
  }

  const trustedClientIp = headers.get(railwayClientIpHeader)?.trim();
  if (!trustedClientIp || isIP(trustedClientIp) === 0) {
    throw new AuthenticationError("trusted_client_ip_unavailable");
  }

  return {
    callerClass: "anonymous",
    bucketHash: bucketHash(
      config.RATE_LIMIT_HASH_SECRET,
      `anonymous:${trustedClientIp}`
    )
  };
}
