import { applicationConfigSchema } from "@slashwho/application";
import type {
  OperatorCredential,
  OperatorSession,
  Repositories
} from "@slashwho/database";
import { describe, expect, it, vi } from "vitest";
import {
  authorizes,
  createAccountAuth,
  canonicalizeOperatorLogin,
  createOperatorAuth,
  hashOperatorCredential
} from "./operator-auth";
import {
  accountAuthFixture,
  operatorMutation,
  operatorOrigin
} from "./operator-auth-test-fixture";
import type {
  AccountCredential,
  OperatorLoginAdmission
} from "@slashwho/database";

const origin = "https://operators.example.test";
const credential = "a-unique-high-entropy-credential";
const config = applicationConfigSchema.parse({
  BOT_API_KEY: "b".repeat(32),
  RATE_LIMIT_HASH_SECRET: "r".repeat(32)
});
const initialTime = new Date("2026-09-21T12:00:00.000Z");
const operatorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

it("signs in with a six-character account password", async () => {
  const fixture = await accountAuthFixture();
  fixture.setAccount(await hashOperatorCredential("abcdef"));
  expect(
    (
      await fixture.auth.signIn(
        operatorMutation({ email: "ryan@example.test", password: "abcdef" })
      )
    ).principal
  ).toMatchObject({ kind: "account", accountId: operatorId });
  expect(
    (
      await fixture.auth.signIn(
        operatorMutation({ email: "ryan@example.test", password: "abcde" })
      )
    ).principal
  ).toBeNull();
});

it("issues a session for a freshly verified account without consuming a login attempt", async () => {
  const fixture = await accountAuthFixture();
  const verified = {
    accountId: operatorId,
    canonicalEmail: "ryan@example.test"
  };
  const signedIn = await fixture.auth.signInVerifiedAccount(
    new Request(operatorOrigin),
    verified
  );
  expect(signedIn.principal).toMatchObject({
    kind: "account",
    accountId: operatorId
  });
  expect(signedIn.cookie?.header).toContain("HttpOnly");
  expect(fixture.repository.admitLoginAttempt).not.toHaveBeenCalled();
  await expect(
    fixture.auth.signInVerifiedAccount(new Request(operatorOrigin), {
      ...verified,
      accountId: "someone-else"
    })
  ).resolves.toEqual({ principal: null });
  fixture.setAccount({ verifiedAt: null });
  await expect(
    fixture.auth.signInVerifiedAccount(new Request(operatorOrigin), verified)
  ).resolves.toEqual({ principal: null });
});

it.each([
  "disabled",
  "unverified",
  "credential-version",
  "idle-expired",
  "absolute-expired"
] as const)(
  "denies an existing account session when %s without relying on revocation",
  async (reason) => {
    const fixture = await accountAuthFixture();
    const cookie = await fixture.cookie();
    const issuedAt = vi.mocked(fixture.repository.issueSession).mock
      .calls[0]![0].issuedAt;
    if (reason === "disabled") fixture.setAccount({ active: false });
    if (reason === "unverified") fixture.setAccount({ verifiedAt: null });
    if (reason === "credential-version")
      fixture.setAccount({ credentialVersion: 2 });
    if (reason === "idle-expired")
      fixture.setTime(new Date(issuedAt.getTime() + 30 * 60_000));
    if (reason === "absolute-expired") {
      for (let minutes = 20; minutes <= 460; minutes += 20) {
        fixture.setTime(new Date(issuedAt.getTime() + minutes * 60_000));
        expect(
          (
            await fixture.auth.authenticate(
              new Request(operatorOrigin, { headers: { cookie } })
            )
          ).principal?.kind
        ).toBe("account");
      }
      fixture.setTime(new Date(issuedAt.getTime() + 8 * 60 * 60_000));
    }
    expect(
      await fixture.auth.authenticate(
        new Request(operatorOrigin, { headers: { cookie } })
      )
    ).toMatchObject({
      principal: null,
      cookie: { maxAge: 0 }
    });
    expect(fixture.repository.revokeSession).not.toHaveBeenCalled();
  }
);

it("authenticates verified accounts and reads current role and required-change state", async () => {
  let account: AccountCredential = {
    id: operatorId,
    canonicalEmail: "ryan@example.test",
    email: "Ryan@example.test",
    role: "user",
    active: true,
    verifiedAt: initialTime,
    passwordChangeRequired: false,
    credentialVersion: 1,
    createdAt: initialTime,
    updatedAt: initialTime,
    ...(await hashOperatorCredential(credential))
  };
  let session: {
    id: string;
    secretDigest: string;
    credentialVersion: number;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    revokedAt: Date | null;
  } | null = null;
  const repository = {
    findCredential: vi.fn(async (email: string) =>
      email === account.canonicalEmail ? account : null
    ),
    admitLoginAttempt: vi.fn(
      async (
        _input: Parameters<Repositories["accountAuth"]["admitLoginAttempt"]>[0]
      ): Promise<OperatorLoginAdmission> => {
        void _input;
        return { kind: "admitted" };
      }
    ),
    appendEvent: vi.fn(async () => {}),
    issueSession: vi.fn(
      async (
        input: Parameters<Repositories["accountAuth"]["issueSession"]>[0]
      ) => {
        session = { ...input, id: input.sessionId, revokedAt: null };
        return {
          ...session,
          accountId: account.id,
          issuedAt: initialTime,
          lastUsedAt: initialTime
        };
      }
    ),
    useSession: vi.fn(
      async (input: {
        sessionId: string;
        secretDigest: string;
        at: Date;
        idleExpiresAt: Date;
      }) => {
        if (
          !session ||
          session.id !== input.sessionId ||
          session.secretDigest !== input.secretDigest ||
          session.revokedAt ||
          !account.active ||
          !account.verifiedAt ||
          session.credentialVersion !== account.credentialVersion ||
          session.idleExpiresAt <= input.at ||
          session.absoluteExpiresAt <= input.at
        )
          return null;
        session = { ...session, idleExpiresAt: input.idleExpiresAt };
        return {
          account,
          session: {
            ...session,
            accountId: account.id,
            issuedAt: initialTime,
            lastUsedAt: input.at
          }
        };
      }
    ),
    revokeSession: vi.fn(async () => {}),
    changePassword: vi.fn(
      async (input: {
        accountId: string;
        sessionId: string;
        expectedCredentialVersion: number;
        passwordHash: string;
        passwordSalt: string;
        scryptVersion: number;
        scryptCost: number;
      }) => {
        if (
          input.accountId !== account.id ||
          !session ||
          input.sessionId !== session.id ||
          input.expectedCredentialVersion !== account.credentialVersion
        )
          return false;
        account = {
          ...account,
          ...input,
          passwordChangeRequired: false,
          credentialVersion: account.credentialVersion + 1
        };
        session = { ...session, revokedAt: initialTime };
        return true;
      }
    )
  };
  const auth = createAccountAuth({
    repository,
    config,
    origin,
    sessionHashSecret: "s".repeat(32),
    now: () => initialTime
  });
  const signIn = (headers: Record<string, string> = {}) =>
    mutation({ email: " RYAN@EXAMPLE.TEST ", password: credential }, headers);
  const signedIn = await auth.signIn(signIn());
  expect(signedIn.principal).toMatchObject({
    kind: "account",
    role: "user",
    accountId: operatorId
  });
  const cookie = signedIn.cookie!.header.split(";")[0]!;
  account = { ...account, role: "admin", passwordChangeRequired: true };
  const live = await auth.authenticate(
    new Request(origin, { headers: { cookie } })
  );
  expect(live.principal).toMatchObject({
    role: "admin",
    passwordChangeRequired: true
  });
  expect(authorizes(live.principal, "admin")).toBe(false);
  expect(
    (
      await auth.authenticate(
        new Request(origin, {
          headers: { cookie, authorization: "Bearer invalid" }
        })
      )
    ).principal
  ).toBeNull();
  account = { ...account, verifiedAt: null };
  expect((await auth.signIn(signIn())).principal).toBeNull();
  account = { ...account, verifiedAt: initialTime, active: false };
  expect((await auth.signIn(signIn())).principal).toBeNull();
  vi.mocked(repository.admitLoginAttempt).mockResolvedValueOnce({
    kind: "throttled",
    retryAt: initialTime
  });
  expect((await auth.signIn(signIn())).principal).toBeNull();
  expect(
    vi.mocked(repository.admitLoginAttempt).mock.calls.at(-1)?.[0]
  ).toMatchObject({
    limit: 5,
    expiresAt: new Date("2026-09-21T12:15:00Z")
  });
  account = { ...account, active: true, passwordChangeRequired: true };
  expect(
    (
      await auth.changePassword(
        ...passwordChange(
          {
            currentPassword: credential,
            newPassword: "abcdef"
          },
          { cookie, origin: "https://evil.test" }
        )
      )
    ).accepted
  ).toBe(false);
  expect(
    (
      await auth.changePassword(
        ...passwordChange(
          {
            currentPassword: "incorrect-but-long-password",
            newPassword: "another-long-secret-password"
          },
          { cookie }
        )
      )
    ).accepted
  ).toBe(false);
  expect(
    (
      await auth.changePassword(
        ...passwordChange(
          {
            currentPassword: credential,
            newPassword: "abcdef"
          },
          { cookie }
        )
      )
    ).accepted
  ).toBe(true);
  expect(account.passwordChangeRequired).toBe(false);
  expect(account.credentialVersion).toBe(2);
  expect(
    (await auth.authenticate(new Request(origin, { headers: { cookie } })))
      .principal
  ).toBeNull();
});

/** The route parses the body once and passes it on beside the request. */
function passwordChange(
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): [Request, Record<string, unknown>] {
  return [mutation(body, headers), body];
}

function mutation(
  body: unknown = { login: "RYAN", credential },
  headers: Record<string, string> = {},
  method = "POST"
) {
  return new Request(`${origin}/api/operator/session`, {
    method,
    headers: {
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-real-ip": "192.0.2.1",
      ...headers
    },
    ...(method !== "GET" ? { body: JSON.stringify(body) } : {})
  });
}

async function fixture() {
  let time = initialTime;
  let operator: OperatorCredential = {
    id: operatorId,
    canonicalLogin: "ryan",
    displayLogin: "Ryan",
    active: true,
    credentialVersion: 1,
    createdAt: initialTime,
    updatedAt: initialTime,
    ...(await hashOperatorCredential(credential))
  };
  const sessions = new Map<
    string,
    OperatorSession & { secretDigest: string }
  >();
  const repository: Repositories["operatorAuth"] = {
    findCredential: vi.fn(async (login) =>
      login === operator.canonicalLogin ? operator : null
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
        !operator.active ||
        session.credentialVersion !== operator.credentialVersion ||
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
    revokeSession: vi.fn(async (id, at) => {
      const session = sessions.get(id);
      if (session) sessions.set(id, { ...session, revokedAt: at });
    })
  };
  const options = {
    repository,
    config,
    origin,
    sessionHashSecret: "s".repeat(32),
    now: () => time
  };
  const auth = createOperatorAuth(options);
  return {
    auth,
    options,
    repository,
    setTime: (at: Date) => {
      time = at;
    },
    changeOperator: (change: Partial<OperatorCredential>) => {
      operator = { ...operator, ...change };
    },
    request: (cookie: string, headers: Record<string, string> = {}) =>
      new Request(origin, { headers: { cookie, ...headers } })
  };
}

describe("operator identity and credentials", () => {
  it("canonicalizes only bounded ASCII login forms", () => {
    expect(canonicalizeOperatorLogin("Ryan_2-ops")).toBe("ryan_2-ops");
    for (const login of [
      "",
      " Ryan",
      "Ryan ",
      "r.yan",
      "rÿan",
      "Ｒyan",
      "a".repeat(65),
      "ryan\n",
      "ryan\r"
    ])
      expect(canonicalizeOperatorLogin(login)).toBeNull();
  });
  it("derives salted versioned credentials without retaining the reusable secret", async () => {
    const first = await hashOperatorCredential(credential);
    const second = await hashOperatorCredential(credential);
    expect(first).toMatchObject({ scryptVersion: 1, scryptCost: 16384 });
    expect(first.passwordHash).toMatch(/^[a-f0-9]{128}$/);
    expect(first.passwordSalt).toMatch(/^[a-f0-9]{32}$/);
    expect(second.passwordHash).not.toBe(first.passwordHash);
    expect(second.passwordSalt).not.toBe(first.passwordSalt);
    expect(JSON.stringify(first)).not.toContain(credential);
    await expect(hashOperatorCredential("short")).rejects.toThrow(
      "invalid_operator_credential"
    );
  });
  it("hashes six-character passwords and rejects five-character passwords", async () => {
    await expect(hashOperatorCredential("abcde")).rejects.toThrow(
      "invalid_operator_credential"
    );
    await expect(hashOperatorCredential("abcdef")).resolves.toMatchObject({
      scryptVersion: 1
    });
  });
});

describe("operator authentication", () => {
  it("signs in with a six-character operator credential", async () => {
    const f = await fixture();
    f.changeOperator(await hashOperatorCredential("abcdef"));
    expect(
      (await f.auth.signIn(mutation({ login: "Ryan", credential: "abcdef" })))
        .principal
    ).toMatchObject({ kind: "operator" });
  });
  it("verifies existing scrypt records using their stored cost", async () => {
    const f = await fixture();
    // Independent Node scrypt vector: N=32768, r=8, p=1, 64 bytes, salt=16 bytes of 0x07.
    f.changeOperator({
      passwordSalt: "07".repeat(16),
      scryptCost: 32768,
      passwordHash:
        "a3a54dd72ce3fac0fefe916790e04c6f3d6cbbeef570646e577b74fe5aa4bbe23951932c2c417494f64cefb95d47aea70ead0f0798b2b8b45cd1dd4f1be2e9ba"
    });
    await expect(f.auth.signIn(mutation())).resolves.toMatchObject({
      principal: { kind: "operator" }
    });
    f.changeOperator({ scryptVersion: 2 });
    await expect(f.auth.signIn(mutation())).resolves.toMatchObject({
      principal: null
    });
  });

  it("does not revoke a second browser's session on sign-out", async () => {
    const f = await fixture();
    const first = (await f.auth.signIn(mutation())).cookie!.header.split(
      ";"
    )[0]!;
    const second = (await f.auth.signIn(mutation())).cookie!.header.split(
      ";"
    )[0]!;
    await f.auth.signOut(mutation({}, { cookie: first }));
    await expect(
      f.auth.authenticateOperator(f.request(first))
    ).resolves.toMatchObject({ principal: null });
    await expect(
      f.auth.authenticateOperator(f.request(second))
    ).resolves.toMatchObject({ principal: { kind: "operator" } });
  });

  it("clears an otherwise well-formed token when its random secret is tampered", async () => {
    const f = await fixture();
    const cookie = (await f.auth.signIn(mutation())).cookie!.header.split(
      ";"
    )[0]!;
    const secretStart = cookie.lastIndexOf(".") + 1;
    const tampered = `${cookie.slice(0, secretStart)}${cookie[secretStart] === "A" ? "B" : "A"}${cookie.slice(secretStart + 1)}`;
    await expect(
      f.auth.authenticateOperator(f.request(tampered))
    ).resolves.toMatchObject({ principal: null, cookie: { maxAge: 0 } });
    await expect(
      f.auth.authenticateOperator(f.request(cookie))
    ).resolves.toMatchObject({ principal: { kind: "operator" } });
  });

  it("rejects malformed JSON and oversized bodies without attempting credential verification", async () => {
    const f = await fixture();
    for (const body of [
      "{",
      "null",
      "[]",
      JSON.stringify({ login: "Ryan", credential: "a".repeat(8192) })
    ]) {
      const request = new Request(`${origin}/api/operator/session`, {
        method: "POST",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json"
        },
        body
      });
      const signOutRequest = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body
      });
      await expect(f.auth.signIn(request)).resolves.toEqual({
        principal: null
      });
      await expect(f.auth.signOut(signOutRequest)).resolves.toEqual({
        principal: null,
        accepted: false
      });
    }
    expect(f.repository.findCredential).not.toHaveBeenCalled();
    expect(f.repository.issueSession).not.toHaveBeenCalled();
  });

  it.each(["inactive", "credential-rotated", "idle-expired"])(
    "clears a %s session denied by authoritative repository use",
    async (reason) => {
      const f = await fixture();
      const cookie = (await f.auth.signIn(mutation())).cookie!.header.split(
        ";"
      )[0]!;
      if (reason === "inactive") f.changeOperator({ active: false });
      if (reason === "credential-rotated")
        f.changeOperator({ credentialVersion: 2 });
      if (reason === "idle-expired")
        f.setTime(new Date("2026-09-21T12:30:00Z"));
      await expect(
        f.auth.authenticateOperator(f.request(cookie))
      ).resolves.toMatchObject({ principal: null, cookie: { maxAge: 0 } });
    }
  );

  it("denies a sign-in with invalid Authorization even when credentials and a cookie are valid", async () => {
    const f = await fixture();
    const cookie = (await f.auth.signIn(mutation())).cookie!.header.split(
      ";"
    )[0]!;
    vi.mocked(f.repository.issueSession).mockClear();
    await expect(
      f.auth.signIn(
        mutation(undefined, { cookie, authorization: "Bearer invalid" })
      )
    ).resolves.toEqual({ principal: null });
    expect(f.repository.issueSession).not.toHaveBeenCalled();
    expect(f.repository.revokeSession).not.toHaveBeenCalled();
  });

  it("distinguishes rejected sign-out requests from accepted sign-out", async () => {
    const f = await fixture();
    const cookie = (await f.auth.signIn(mutation())).cookie!.header.split(
      ";"
    )[0]!;
    await expect(
      f.auth.signOut(mutation({}, { cookie, origin: "https://evil.test" }))
    ).resolves.toEqual({ principal: null, accepted: false });
    await expect(
      f.auth.authenticateOperator(f.request(cookie))
    ).resolves.toMatchObject({ principal: { kind: "operator" } });
    await expect(
      f.auth.signOut(mutation({}, { cookie }))
    ).resolves.toMatchObject({
      accepted: true,
      principal: null,
      cookie: { maxAge: 0 }
    });
    await expect(f.auth.signOut(mutation({}))).resolves.toMatchObject({
      accepted: true
    });
  });
  it("preserves Bearer automation and denies invalid Authorization before a valid cookie", async () => {
    const f = await fixture();
    const signedIn = await f.auth.signIn(mutation());
    const cookie = signedIn.cookie!.header.split(";")[0]!;
    await expect(
      f.auth.authenticateOperator(
        f.request(cookie, { authorization: `Bearer ${config.BOT_API_KEY}` })
      )
    ).resolves.toEqual({ principal: { kind: "automation" } });
    for (const authorization of ["Bearer invalid", "Basic invalid", ""])
      await expect(
        f.auth.authenticateOperator(f.request(cookie, { authorization }))
      ).resolves.toMatchObject({ principal: null });
    expect(f.repository.useSession).not.toHaveBeenCalled();
  });
  it("issues an opaque hardened cookie and returns only the accountable principal", async () => {
    const f = await fixture();
    const result = await f.auth.signIn(mutation());
    expect(result.principal).toEqual({
      kind: "operator",
      operatorId,
      login: "Ryan",
      role: "operator"
    });
    expect(result.cookie!.header).toMatch(
      /^__Host-slashwho-operator=v1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=1800; Expires=Mon, 21 Sep 2026 12:30:00 GMT; HttpOnly; Secure; SameSite=Strict$/
    );
    expect(result.cookie).toMatchObject({
      maxAge: 1800,
      expires: new Date("2026-09-21T12:30:00Z")
    });
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(f.repository.appendEvent).toHaveBeenCalledWith({
      operatorId,
      action: "sign_in",
      outcome: "success",
      at: initialTime
    });
    expect(f.repository.issueSession).toHaveBeenCalledWith(
      expect.objectContaining({
        absoluteExpiresAt: new Date("2026-09-21T20:00:00Z"),
        secretDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    );
  });
  it("uses the same generic denial for unknown, disabled, invalid and throttled credentials", async () => {
    const f = await fixture();
    const unknown = await f.auth.signIn(
      mutation({ login: "missing", credential })
    );
    const wrong = await f.auth.signIn(
      mutation({ login: "Ryan", credential: "incorrect-but-long-credential" })
    );
    f.changeOperator({ active: false });
    const disabled = await f.auth.signIn(mutation());
    vi.mocked(f.repository.admitLoginAttempt).mockResolvedValue({
      kind: "throttled",
      retryAt: initialTime
    });
    const throttled = await f.auth.signIn(mutation());
    expect(unknown).toEqual({ principal: null });
    expect(wrong).toEqual(unknown);
    expect(disabled).toEqual(unknown);
    expect(throttled).toEqual(unknown);
    expect(f.repository.issueSession).not.toHaveBeenCalled();
    for (const [event] of vi.mocked(f.repository.appendEvent).mock.calls)
      expect(Object.keys(event).sort()).toEqual([
        "action",
        "at",
        "operatorId",
        "outcome"
      ]);
  });
  it.each([
    [{ origin: "https://evil.test" }, "POST"],
    [{ origin: "" }, "POST"],
    [{ origin: `${origin}/` }, "POST"],
    [{ "sec-fetch-site": "same-site" }, "POST"],
    [{ "sec-fetch-site": "" }, "POST"],
    [{ "content-type": "text/plain" }, "POST"],
    [{}, "GET"],
    [{}, "DELETE"]
  ] as const)(
    "rejects invalid mutation request %j %s before changing session state",
    async (headers, method) => {
      const f = await fixture();
      await expect(
        f.auth.signIn(mutation(undefined, headers, method))
      ).resolves.toEqual({ principal: null });
      await expect(
        f.auth.signOut(mutation({}, headers, method))
      ).resolves.toEqual({ principal: null, accepted: false });
      expect(f.repository.issueSession).not.toHaveBeenCalled();
      expect(f.repository.revokeSession).not.toHaveBeenCalled();
    }
  );
  it("uses one bounded fallback bucket when trusted client IP is unavailable", async () => {
    const f = await fixture();
    await f.auth.signIn(
      mutation(
        { login: "missing", credential },
        { "x-real-ip": "", "x-forwarded-for": "192.0.2.8" }
      )
    );
    await f.auth.signIn(
      mutation(
        { login: "different", credential },
        { "x-real-ip": "invalid", "x-forwarded-for": "192.0.2.9" }
      )
    );
    const calls = vi.mocked(f.repository.admitLoginAttempt).mock.calls;
    expect(calls[0]![0]).toEqual(calls[1]![0]);
    expect(calls[0]![0]).toMatchObject({
      subjectHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      limit: 20,
      expiresAt: new Date("2026-09-21T12:15:00Z")
    });
    await f.auth.signIn(mutation());
    expect(calls[2]![0]).toMatchObject({ limit: 5 });
    expect(calls[2]![0].subjectHash).not.toBe(calls[0]![0].subjectHash);
  });
  it("expires malformed, duplicate, legacy and tampered cookies", async () => {
    const f = await fixture();
    const cookie = (await f.auth.signIn(mutation())).cookie!.header.split(
      ";"
    )[0]!;
    for (const value of [
      "__Host-slashwho-operator=garbage",
      `${cookie}; ${cookie}`,
      `${cookie.slice(0, -1)}!`,
      "__Host-slashwho-operator=v1.100.200.legacy.signature"
    ])
      await expect(
        f.auth.authenticateOperator(f.request(value))
      ).resolves.toMatchObject({
        principal: null,
        cookie: { maxAge: 0, expires: new Date(0) }
      });
    await expect(
      f.auth.authenticateOperator(new Request(origin))
    ).resolves.toEqual({ principal: null });
  });
  it("renews idle use while limiting cookie expiry to the absolute deadline", async () => {
    const f = await fixture();
    const cookie = (await f.auth.signIn(mutation())).cookie!.header.split(
      ";"
    )[0]!;
    for (let minutes = 20; minutes <= 460; minutes += 20) {
      f.setTime(new Date(initialTime.getTime() + minutes * 60_000));
      expect(
        (await f.auth.authenticateOperator(f.request(cookie))).principal?.kind
      ).toBe("operator");
    }
    f.setTime(new Date("2026-09-21T19:50:00Z"));
    await expect(
      f.auth.authenticateOperator(f.request(cookie))
    ).resolves.toMatchObject({
      cookie: { maxAge: 600, expires: new Date("2026-09-21T20:00:00Z") }
    });
    f.setTime(new Date("2026-09-21T20:00:00Z"));
    await expect(
      f.auth.authenticateOperator(f.request(cookie))
    ).resolves.toMatchObject({ principal: null, cookie: { maxAge: 0 } });
  });
  it("revokes the current session on sign-out and rotates the prior session on sign-in", async () => {
    const f = await fixture();
    const first = (await f.auth.signIn(mutation())).cookie!.header.split(
      ";"
    )[0]!;
    const second = (
      await f.auth.signIn(mutation(undefined, { cookie: first }))
    ).cookie!.header.split(";")[0]!;
    expect(second).not.toBe(first);
    await expect(
      f.auth.authenticateOperator(f.request(first))
    ).resolves.toMatchObject({ principal: null });
    await expect(
      f.auth.signOut(mutation({}, { cookie: second }))
    ).resolves.toMatchObject({ principal: null, cookie: { maxAge: 0 } });
    await expect(
      f.auth.authenticateOperator(f.request(second))
    ).resolves.toMatchObject({ principal: null });
    expect(f.repository.appendEvent).toHaveBeenCalledWith({
      operatorId,
      action: "sign_out",
      outcome: "success",
      at: initialTime
    });
  });
  it("invalidates sessions when the independent session hashing secret rotates", async () => {
    const f = await fixture();
    const cookie = (await f.auth.signIn(mutation())).cookie!.header.split(
      ";"
    )[0]!;
    const rotated = createOperatorAuth({
      ...f.options,
      sessionHashSecret: "z".repeat(32)
    });
    await expect(
      rotated.authenticateOperator(f.request(cookie))
    ).resolves.toMatchObject({ principal: null, cookie: { maxAge: 0 } });
    await expect(rotated.signIn(mutation())).resolves.toMatchObject({
      principal: { kind: "operator" }
    });
  });
});
