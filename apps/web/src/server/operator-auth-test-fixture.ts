import { applicationConfigSchema } from "@slashwho/application";
import type {
  AccountCredential,
  AccountSession,
  OperatorCredential,
  OperatorSession,
  Repositories
} from "@slashwho/database";
import { vi } from "vitest";
import {
  createAccountAuth,
  createOperatorAuth,
  hashOperatorCredential
} from "./operator-auth";

export const operatorOrigin = "https://slashwho.example";
export const operatorLogin = "Ryan";
export const operatorCredential = "unique-operator-credential-for-tests";
export const accountEmail = "ryan@example.test";
export const automationKey = "automation-key-that-is-at-least-32-characters";

export function operatorMutation(
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST"
) {
  return new Request(`${operatorOrigin}/api/operations/session`, {
    method,
    headers: {
      origin: operatorOrigin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers
    },
    ...(method !== "GET"
      ? { body: typeof body === "string" ? body : JSON.stringify(body) }
      : {})
  });
}

export async function accountAuthFixture() {
  const at = new Date();
  let account: AccountCredential = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    canonicalEmail: accountEmail,
    email: accountEmail,
    role: "user",
    active: true,
    verifiedAt: at,
    passwordChangeRequired: false,
    credentialVersion: 1,
    createdAt: at,
    updatedAt: at,
    ...(await hashOperatorCredential(operatorCredential))
  };
  const sessions = new Map<string, AccountSession & { secretDigest: string }>();
  const repository = {
    findCredential: vi.fn(async (email: string) =>
      email === accountEmail ? account : null
    ),
    admitLoginAttempt: vi.fn(async () => ({ kind: "admitted" as const })),
    appendEvent: vi.fn(async () => {}),
    issueSession: vi.fn(
      async (
        input: Parameters<Repositories["accountAuth"]["issueSession"]>[0]
      ) => {
        const session = { ...input, id: input.sessionId, revokedAt: null };
        sessions.set(session.id, {
          ...session,
          secretDigest: input.secretDigest
        });
        return session;
      }
    ),
    useSession: vi.fn(
      async (
        input: Parameters<Repositories["accountAuth"]["useSession"]>[0]
      ) => {
        const session = sessions.get(input.sessionId);
        if (
          !session ||
          session.secretDigest !== input.secretDigest ||
          session.revokedAt ||
          session.idleExpiresAt <= input.at ||
          session.absoluteExpiresAt <= input.at ||
          !account.active ||
          !account.verifiedAt ||
          session.credentialVersion !== account.credentialVersion
        )
          return null;
        const renewed = {
          ...session,
          lastUsedAt: input.at,
          idleExpiresAt: new Date(
            Math.min(
              input.idleExpiresAt.getTime(),
              session.absoluteExpiresAt.getTime()
            )
          )
        };
        sessions.set(session.id, renewed);
        return { account, session: renewed };
      }
    ),
    revokeSession: vi.fn(async (id: string, time: Date) => {
      const session = sessions.get(id);
      if (session) sessions.set(id, { ...session, revokedAt: time });
    }),
    changePassword: vi.fn(async () => false)
  };
  const config = applicationConfigSchema.parse({
    BOT_API_KEY: automationKey,
    RATE_LIMIT_HASH_SECRET: "r".repeat(32)
  });
  const auth = createAccountAuth({
    repository,
    config,
    origin: operatorOrigin,
    sessionHashSecret: "s".repeat(32)
  });
  return {
    auth,
    repository,
    config,
    setAccount(change: Partial<AccountCredential>) {
      account = { ...account, ...change };
    },
    async cookie() {
      const result = await auth.signIn(
        operatorMutation({ email: accountEmail, password: operatorCredential })
      );
      return result.cookie!.header.split(";", 1)[0]!;
    }
  };
}

export async function operatorAuthFixture() {
  const at = new Date();
  const operator: OperatorCredential = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    canonicalLogin: "ryan",
    displayLogin: operatorLogin,
    active: true,
    credentialVersion: 1,
    createdAt: at,
    updatedAt: at,
    ...(await hashOperatorCredential(operatorCredential))
  };
  const sessions = new Map<
    string,
    OperatorSession & { secretDigest: string }
  >();
  const repository: Repositories["operatorAuth"] = {
    findCredential: vi.fn(async (login) =>
      login === "ryan" ? operator : null
    ),
    provision: vi.fn(),
    rotateCredential: vi.fn(),
    disable: vi.fn(),
    list: vi.fn(),
    cleanupExpired: vi.fn(),
    admitLoginAttempt: vi.fn(async () => ({ kind: "admitted" as const })),
    appendEvent: vi.fn(async () => {}),
    issueSession: vi.fn(async (input) => {
      const session = { ...input, id: input.sessionId, revokedAt: null };
      sessions.set(session.id, session);
      return session;
    }),
    useSession: vi.fn(async (input) => {
      const session = sessions.get(input.sessionId);
      if (
        !session ||
        session.secretDigest !== input.secretDigest ||
        session.revokedAt ||
        session.idleExpiresAt <= input.at ||
        session.absoluteExpiresAt <= input.at
      )
        return null;
      const renewed = {
        ...session,
        lastUsedAt: input.at,
        idleExpiresAt: new Date(
          Math.min(
            input.idleExpiresAt.getTime(),
            session.absoluteExpiresAt.getTime()
          )
        )
      };
      sessions.set(session.id, renewed);
      return { operator, session: renewed };
    }),
    revokeSession: vi.fn(async (id, time) => {
      const session = sessions.get(id);
      if (session) sessions.set(id, { ...session, revokedAt: time });
    })
  };
  const config = applicationConfigSchema.parse({
    BOT_API_KEY: automationKey,
    RATE_LIMIT_HASH_SECRET: "r".repeat(32)
  });
  const auth = createOperatorAuth({
    repository,
    config,
    origin: operatorOrigin,
    sessionHashSecret: "s".repeat(32)
  });
  return {
    auth,
    repository,
    config,
    async cookie() {
      const result = await auth.signIn(
        operatorMutation({
          login: operatorLogin,
          credential: operatorCredential
        })
      );
      return result.cookie!.header.split(";", 1)[0]!;
    }
  };
}
