import { beforeEach, describe, expect, it, vi } from "vitest";
import { operatorMutation } from "../../../server/operator-auth-test-fixture";

const state = vi.hoisted(() => ({
  registerPending: vi.fn(),
  admitRegistration: vi.fn(),
  issueVerification: vi.fn(),
  authenticate: vi.fn(),
  requestReset: vi.fn(),
  confirmVerification: vi.fn(),
  signInVerifiedAccount: vi.fn(),
  completeReset: vi.fn()
}));
vi.mock("../../../server/container", () => ({
  getContainer: async () => ({
    accountOrigin: "https://slashwho.example",
    accountTokens: state,
    accountRegistration: state,
    registrationHashSecret: "r".repeat(32),
    accountAuth: state
  })
}));
import { POST as register } from "./register/route";
import { POST as recovery } from "./recovery/route";
import { GET as session } from "./session/route";
import { POST as verify } from "./verify/route";
import { POST as password } from "./password/route";

beforeEach(() => {
  vi.clearAllMocks();
  state.admitRegistration.mockResolvedValue("admitted");
  state.registerPending.mockResolvedValue({
    kind: "created",
    accountId: "account-1"
  });
  state.authenticate.mockResolvedValue({ principal: null });
  state.confirmVerification.mockResolvedValue({
    accountId: "account-1",
    canonicalEmail: "r@example.test"
  });
  state.signInVerifiedAccount.mockResolvedValue({
    principal: {
      kind: "account",
      accountId: "account-1",
      passwordChangeRequired: false
    },
    cookie: { header: "__Host-slashwho-account=session; Path=/; HttpOnly" }
  });
});

describe("account routes", () => {
  it("signs in immediately after successful email verification", async () => {
    const response = await verify(
      operatorMutation({ token: "token", password: "secret" })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(
      "__Host-slashwho-account=session"
    );
    expect(state.signInVerifiedAccount).toHaveBeenCalledWith(
      expect.any(Request),
      {
        accountId: "account-1",
        canonicalEmail: "r@example.test"
      }
    );
  });

  it("does not create a session for an invalid verification", async () => {
    state.confirmVerification.mockResolvedValue("invalid");
    const response = await verify(
      operatorMutation({ token: "bad", password: "secret" })
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(state.signInVerifiedAccount).not.toHaveBeenCalled();
  });
  it("accepts registration and gives a duplicate the same response", async () => {
    const body = {
      email: "Ryan@Example.test",
      password: "password-longer-than-20-characters"
    };
    const created = await register(operatorMutation(body));
    expect(created.status).toBe(202);
    expect(state.issueVerification).toHaveBeenCalledOnce();
    state.registerPending.mockResolvedValue({ kind: "existing" });
    const existing = await register(operatorMutation(body));
    expect(existing.status).toBe(202);
    expect(await existing.text()).toBe(await created.text());
    expect(state.issueVerification).toHaveBeenCalledOnce();
  });

  it("rejects cross-site and oversized registration before persistence", async () => {
    expect(
      (
        await register(
          operatorMutation(
            { email: "r@example.test", password: "x".repeat(25) },
            { origin: "https://evil.example" }
          )
        )
      ).status
    ).toBe(400);
    expect(
      (
        await register(
          operatorMutation({
            email: "r@example.test",
            password: "x".repeat(9000)
          })
        )
      ).status
    ).toBe(400);
    expect(state.registerPending).not.toHaveBeenCalled();
  });

  it("accepts a six-character registration password and rejects five characters", async () => {
    const email = "short@example.test";
    expect(
      (await register(operatorMutation({ email, password: "abcde" }))).status
    ).toBe(400);
    expect(
      (await register(operatorMutation({ email, password: "abcdef" }))).status
    ).toBe(202);
  });

  it("accepts a six-character reset password and rejects five characters", async () => {
    state.completeReset.mockResolvedValue("changed");
    expect(
      (
        await password(
          operatorMutation({ token: "token", newPassword: "abcde" })
        )
      ).status
    ).toBe(400);
    expect(
      (
        await password(
          operatorMutation({ token: "token", newPassword: "abcdef" })
        )
      ).status
    ).toBe(200);
  });

  it("returns generic recovery and a safe own-session projection", async () => {
    expect(
      (await recovery(operatorMutation({ email: "unknown@example.test" })))
        .status
    ).toBe(202);
    state.authenticate.mockResolvedValue({
      principal: {
        kind: "account",
        accountId: "secret-id",
        email: "r@example.test",
        role: "admin",
        passwordChangeRequired: false
      }
    });
    const result = await session(
      new Request("https://slashwho.example/api/account/session")
    );
    expect(await result.json()).toEqual({
      account: {
        email: "r@example.test",
        role: "admin",
        passwordChangeRequired: false
      }
    });
  });
});
