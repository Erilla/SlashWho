import {
  AuthenticationError,
  classifyCaller,
  type ApplicationConfig
} from "@slashwho/application";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const operatorSessionCookieName = "__Host-slashwho-operator";
export const operatorSessionTtlSeconds = 30 * 60;

type SessionOptions = Readonly<{
  now?: Date;
  nonce?: Uint8Array;
}>;

function signingKey(config: ApplicationConfig): Buffer {
  return createHmac("sha256", config.RATE_LIMIT_HASH_SECRET)
    .update("slashwho-operator-session\0")
    .update(config.BOT_API_KEY)
    .digest();
}

function signature(payload: string, config: ApplicationConfig): string {
  return createHmac("sha256", signingKey(config))
    .update(payload)
    .digest("base64url");
}

function hasValidBearer(
  headers: Pick<Headers, "get">,
  config: ApplicationConfig
): boolean {
  try {
    return classifyCaller(headers, config).callerClass === "bot";
  } catch (error) {
    if (error instanceof AuthenticationError) return false;
    throw error;
  }
}

function hardenedCookie(value: string, maxAge: number): string {
  return `${operatorSessionCookieName}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export function createOperatorSessionCookie(
  presentedKey: string,
  config: ApplicationConfig,
  options: SessionOptions = {}
): string | null {
  try {
    if (
      !hasValidBearer(
        new Headers({ authorization: `Bearer ${presentedKey}` }),
        config
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const now = options.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1_000);
  if (!Number.isSafeInteger(issuedAt)) return null;
  const expiresAt = issuedAt + operatorSessionTtlSeconds;
  const nonce = Buffer.from(options.nonce ?? randomBytes(18)).toString(
    "base64url"
  );
  const payload = `v1.${issuedAt}.${expiresAt}.${nonce}`;
  return hardenedCookie(
    `${payload}.${signature(payload, config)}`,
    operatorSessionTtlSeconds
  );
}

export function clearOperatorSessionCookie(): string {
  return hardenedCookie("", 0);
}

function sessionCookie(headers: Pick<Headers, "get">): string | null {
  const values = (headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${operatorSessionCookieName}=`))
    .map((part) => part.slice(operatorSessionCookieName.length + 1));
  return values.length === 1 ? values[0]! : null;
}

function hasValidSession(
  headers: Pick<Headers, "get">,
  config: ApplicationConfig,
  now: Date
): boolean {
  const token = sessionCookie(headers);
  if (token === null) return false;
  const parts = token.split(".");
  if (parts.length !== 5) return false;
  const [version, issuedText, expiresText, nonce, presentedSignature] = parts;
  if (
    version !== "v1" ||
    !/^\d+$/.test(issuedText!) ||
    !/^\d+$/.test(expiresText!) ||
    !/^[A-Za-z0-9_-]{24}$/.test(nonce!) ||
    !/^[A-Za-z0-9_-]{43}$/.test(presentedSignature!)
  ) {
    return false;
  }
  const issuedAt = Number(issuedText);
  const expiresAt = Number(expiresText);
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(nowSeconds) ||
    issuedAt > nowSeconds ||
    expiresAt <= nowSeconds ||
    expiresAt - issuedAt !== operatorSessionTtlSeconds
  ) {
    return false;
  }

  const payload = parts.slice(0, 4).join(".");
  const expected = Buffer.from(signature(payload, config));
  const presented = Buffer.from(presentedSignature!);
  return (
    expected.length === presented.length && timingSafeEqual(expected, presented)
  );
}

export function isOperatorRequest(
  headers: Pick<Headers, "get">,
  config: ApplicationConfig,
  options: Pick<SessionOptions, "now"> = {}
): boolean {
  if (headers.get("authorization") !== null) {
    return hasValidBearer(headers, config);
  }
  return hasValidSession(headers, config, options.now ?? new Date());
}
