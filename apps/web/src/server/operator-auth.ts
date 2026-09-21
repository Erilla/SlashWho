import {
  AuthenticationError,
  classifyCaller,
  type ApplicationConfig
} from "@slashwho/application";
import type {
  Operator,
  OperatorCredential,
  OperatorSession,
  Repositories
} from "@slashwho/database";
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const operatorSessionCookieName = "__Host-slashwho-operator";
const idleLifetimeMs = 30 * 60_000;
const absoluteLifetimeMs = 8 * 60 * 60_000;
const loginWindowMs = 15 * 60_000;
const scryptCost = 16_384;
// Version 1 fixes r=8, p=1 and a 64-byte derived key; N is stored separately.
type CredentialHash = Pick<
  OperatorCredential,
  "passwordHash" | "passwordSalt" | "scryptVersion" | "scryptCost"
>;
type RandomSource = (size: number) => Uint8Array;

export type OperatorPrincipal = Readonly<
  | { kind: "automation" }
  | { kind: "operator"; operatorId: string; login: string; role: "operator" }
>;

export type CookieDirective = Readonly<{
  name: typeof operatorSessionCookieName;
  value: string;
  path: "/";
  httpOnly: true;
  secure: true;
  sameSite: "strict";
  maxAge: number;
  expires: Date;
  header: string;
  cacheControl: "no-store";
}>;

export type OperatorAuthentication = Readonly<{
  principal: OperatorPrincipal | null;
  cookie?: CookieDirective;
}>;
export type OperatorSignOut = Readonly<{
  accepted: boolean;
  principal: null;
  cookie: CookieDirective;
}>;
export type OperatorAuth = ReturnType<typeof createOperatorAuth>;

export function canonicalizeOperatorLogin(login: string): string | null {
  return /^[A-Za-z0-9_-]{1,64}$/.test(login) && !login.endsWith("\n")
    ? login.toLowerCase()
    : null;
}

function derive(
  credential: string,
  salt: string,
  cost: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      credential,
      Buffer.from(salt, "hex"),
      64,
      { N: cost, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key))
    );
  });
}

export async function hashOperatorCredential(
  credential: string,
  random: RandomSource = randomBytes
): Promise<CredentialHash> {
  if (credential.length < 20 || credential.length > 1024)
    throw new Error("invalid_operator_credential");
  const passwordSalt = Buffer.from(random(16)).toString("hex");
  return {
    passwordHash: (await derive(credential, passwordSalt, scryptCost)).toString(
      "hex"
    ),
    passwordSalt,
    scryptVersion: 1,
    scryptCost
  };
}

async function verifyCredential(
  credential: string,
  stored: OperatorCredential | null
): Promise<boolean> {
  const valid =
    stored !== null &&
    stored.scryptVersion === 1 &&
    Number.isInteger(stored.scryptCost) &&
    stored.scryptCost >= scryptCost &&
    stored.scryptCost <= 131_072 &&
    (stored.scryptCost & (stored.scryptCost - 1)) === 0 &&
    /^[a-f0-9]{32}$/.test(stored.passwordSalt) &&
    /^[a-f0-9]{128}$/.test(stored.passwordHash);
  // Unknown identities still pay one derivation; no reusable dummy credential.
  const derived = await derive(
    credential,
    valid ? stored.passwordSalt : "0".repeat(32),
    valid ? stored.scryptCost : scryptCost
  );
  const expected = Buffer.from(
    valid ? stored.passwordHash : "0".repeat(128),
    "hex"
  );
  const matches = timingSafeEqual(derived, expected);
  return valid && matches && stored.active;
}

function cookieDirective(
  value: string,
  expires: Date,
  at: Date
): CookieDirective {
  const maxAge = Math.max(
    0,
    Math.floor((expires.getTime() - at.getTime()) / 1000)
  );
  return {
    name: operatorSessionCookieName,
    value,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge,
    expires,
    cacheControl: "no-store",
    header: `${operatorSessionCookieName}=${value}; Path=/; Max-Age=${maxAge}; Expires=${expires.toUTCString()}; HttpOnly; Secure; SameSite=Strict`
  };
}

function clearCookie(): CookieDirective {
  return cookieDirective("", new Date(0), new Date(0));
}

function parseCookie(request: Request): {
  present: boolean;
  token: string | null;
  sessionId: string | null;
  secret: string | null;
} {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.split("=", 1)[0] === operatorSessionCookieName);
  const token =
    values.length === 1
      ? values[0]!.slice(operatorSessionCookieName.length + 1)
      : null;
  const match =
    token &&
    /^v1\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.([A-Za-z0-9_-]{43})$/.exec(
      token
    );
  return {
    present: values.length > 0,
    token: match ? token : null,
    sessionId: match ? match[1]! : null,
    secret: match ? match[2]! : null
  };
}

function principal(operator: Operator): OperatorPrincipal {
  return {
    kind: "operator",
    operatorId: operator.id,
    login: operator.displayLogin,
    role: "operator"
  };
}

async function mutationBody(
  request: Request,
  origin: string
): Promise<Record<string, unknown> | null> {
  if (
    request.method !== "POST" ||
    request.headers.get("origin") !== origin ||
    request.headers.get("sec-fetch-site") !== "same-origin" ||
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]!
      .trim()
      .toLowerCase() !== "application/json"
  )
    return null;
  // Bound the bytes consumed even when the sender omits Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return null;
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export function createOperatorAuth(options: {
  repository: Repositories["operatorAuth"];
  config: ApplicationConfig;
  origin: string;
  sessionHashSecret: string;
  now?: () => Date;
  random?: RandomSource;
}) {
  const { repository, config } = options;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? randomBytes;
  const secretDigest = (secret: string) =>
    createHmac("sha256", options.sessionHashSecret)
      .update("operator-session\0")
      .update(secret)
      .digest("hex");
  const deny = () =>
    ({
      principal: null,
      cookie: clearCookie()
    }) as const;
  const audit = (
    operatorId: string | null,
    action: "sign_in" | "sign_out" | "session_revoke",
    outcome: "success" | "failure",
    at: Date
  ) => repository.appendEvent({ operatorId, action, outcome, at });

  async function useCookie(request: Request, at: Date) {
    const cookie = parseCookie(request);
    const used =
      cookie.sessionId && cookie.secret
        ? await repository.useSession({
            sessionId: cookie.sessionId,
            secretDigest: secretDigest(cookie.secret),
            at,
            idleExpiresAt: new Date(at.getTime() + idleLifetimeMs)
          })
        : null;
    return { cookie, used };
  }

  function renewal(
    token: string,
    session: OperatorSession,
    at: Date
  ): CookieDirective {
    return cookieDirective(
      token,
      new Date(
        Math.min(
          session.idleExpiresAt.getTime(),
          session.absoluteExpiresAt.getTime()
        )
      ),
      at
    );
  }

  async function authenticateOperator(
    request: Request
  ): Promise<OperatorAuthentication> {
    if (request.headers.has("authorization")) {
      try {
        return {
          principal:
            classifyCaller(request.headers, config).callerClass === "bot"
              ? { kind: "automation" }
              : null
        };
      } catch (error) {
        if (error instanceof AuthenticationError) return { principal: null };
        throw error;
      }
    }
    const at = now();
    const { cookie, used } = await useCookie(request, at);
    if (!used) return cookie.present ? deny() : { principal: null };
    return {
      principal: principal(used.operator),
      cookie: renewal(cookie.token!, used.session, at)
    };
  }

  async function signIn(request: Request): Promise<OperatorAuthentication> {
    const at = now();
    if (
      request.headers.has("authorization") &&
      !(await authenticateOperator(request)).principal
    ) {
      await audit(null, "sign_in", "failure", at);
      return deny();
    }
    const body = await mutationBody(request, options.origin);
    const login =
      typeof body?.login === "string"
        ? canonicalizeOperatorLogin(body.login)
        : null;
    if (
      !login ||
      typeof body?.credential !== "string" ||
      body.credential.length < 20 ||
      body.credential.length > 1024
    ) {
      await audit(null, "sign_in", "failure", at);
      return deny();
    }
    const ip = request.headers.get("x-real-ip")?.trim();
    const trustedIp = ip && isIP(ip) !== 0 ? ip : null;
    const subjectHash = createHmac("sha256", config.RATE_LIMIT_HASH_SECRET)
      .update(
        trustedIp
          ? `operator-login\0${login}\0${trustedIp}`
          : "operator-login-global\0"
      )
      .digest("hex");
    const admission = await repository.admitLoginAttempt({
      subjectHash,
      limit: trustedIp ? 5 : 20,
      expiresAt: new Date(at.getTime() + loginWindowMs),
      at
    });
    if (admission.kind === "throttled") {
      await audit(null, "sign_in", "failure", at);
      return deny();
    }
    const stored = await repository.findCredential(login);
    if (!(await verifyCredential(body.credential, stored))) {
      await audit(stored?.id ?? null, "sign_in", "failure", at);
      return deny();
    }
    const prior = await useCookie(request, at);
    if (prior.used) {
      await repository.revokeSession(prior.used.session.id, at);
      await audit(prior.used.operator.id, "session_revoke", "success", at);
    }
    const id = Buffer.from(random(16));
    id[6] = (id[6]! & 0x0f) | 0x40;
    id[8] = (id[8]! & 0x3f) | 0x80;
    const hex = id.toString("hex");
    const sessionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const secret = Buffer.from(random(32)).toString("base64url");
    const session = await repository.issueSession({
      sessionId,
      secretDigest: secretDigest(secret),
      operatorId: stored!.id,
      credentialVersion: stored!.credentialVersion,
      issuedAt: at,
      lastUsedAt: at,
      idleExpiresAt: new Date(at.getTime() + idleLifetimeMs),
      absoluteExpiresAt: new Date(at.getTime() + absoluteLifetimeMs)
    });
    await audit(stored!.id, "sign_in", "success", at);
    return {
      principal: principal(stored!),
      cookie: renewal(`v1.${sessionId}.${secret}`, session, at)
    };
  }

  async function signOut(request: Request): Promise<OperatorSignOut> {
    const at = now();
    if (!(await mutationBody(request, options.origin)))
      return { ...deny(), accepted: false };
    // Authorization precedence also applies to session mutations: a malformed
    // Bearer value must not cause a cookie-authenticated revocation.
    if (request.headers.has("authorization"))
      return { ...deny(), accepted: false };
    const { used } = await useCookie(request, at);
    if (used) {
      await repository.revokeSession(used.session.id, at);
      await audit(used.operator.id, "sign_out", "success", at);
    }
    return { ...deny(), accepted: true };
  }

  return { authenticateOperator, signIn, signOut };
}
