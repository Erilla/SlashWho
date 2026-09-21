import { applicationConfigSchema } from "@slashwho/application";
import type {
  OperatorCredential,
  OperatorSession,
  Repositories
} from "@slashwho/database";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeOperatorLogin,
  createOperatorAuth,
  hashOperatorCredential
} from "./operator-auth";

const origin = "https://operators.example.test";
const credential = "a-unique-high-entropy-credential";
const config = applicationConfigSchema.parse({
  BOT_API_KEY: "b".repeat(32),
  RATE_LIMIT_HASH_SECRET: "r".repeat(32)
});
const initialTime = new Date("2026-09-21T12:00:00.000Z");
const operatorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
});

describe("operator authentication", () => {
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
      await expect(f.auth.signIn(request)).resolves.toMatchObject({
        principal: null
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
    ).resolves.toMatchObject({ principal: null });
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
    ).resolves.toMatchObject({ accepted: false });
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
    expect(unknown).toMatchObject({ principal: null, cookie: { maxAge: 0 } });
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
      ).resolves.toMatchObject({ principal: null });
      await expect(
        f.auth.signOut(mutation({}, headers, method))
      ).resolves.toMatchObject({ principal: null });
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
