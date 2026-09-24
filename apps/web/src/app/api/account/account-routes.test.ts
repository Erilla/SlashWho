import { beforeEach, describe, expect, it, vi } from "vitest";
import { operatorMutation } from "../../../server/operator-auth-test-fixture";

const state = vi.hoisted(() => ({
  registerPending: vi.fn(),
  admitRegistration: vi.fn(),
  issueVerification: vi.fn(),
  authenticate: vi.fn(),
  requestReset: vi.fn()
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

beforeEach(() => {
  vi.clearAllMocks();
  state.admitRegistration.mockResolvedValue("admitted");
  state.registerPending.mockResolvedValue({
    kind: "created",
    accountId: "account-1"
  });
  state.authenticate.mockResolvedValue({ principal: null });
});

describe("account routes", () => {
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
