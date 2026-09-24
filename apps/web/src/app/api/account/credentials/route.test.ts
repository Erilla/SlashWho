import { beforeEach, expect, it, vi } from "vitest";
import { operatorMutation } from "../../../../server/operator-auth-test-fixture";

const state = vi.hoisted(() => ({
  available: true,
  authenticate: vi.fn(),
  summary: vi.fn(),
  replace: vi.fn(),
  remove: vi.fn()
}));
vi.mock("../../../../server/container", () => ({
  getContainer: async () => ({
    accountOrigin: "https://slashwho.example",
    accountAuth: state,
    accountCredentials: state.available ? state : null
  })
}));
import { GET, PUT, DELETE } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  state.available = true;
  state.authenticate.mockResolvedValue({
    principal: {
      kind: "account",
      accountId: "alice",
      email: "a@example.test",
      role: "user",
      passwordChangeRequired: false
    }
  });
  state.summary.mockResolvedValue([
    {
      provider: "warcraftlogs",
      present: true,
      version: 1,
      updatedAt: new Date()
    }
  ]);
  state.replace.mockResolvedValue("saved");
  state.remove.mockResolvedValue(true);
});

it("deletes only the current provider version", async () => {
  const request = () =>
    operatorMutation(
      {
        provider: "warcraftlogs",
        expectedVersion: 1,
        expectedAccountEmail: "a@example.test"
      },
      {},
      "DELETE"
    );
  expect((await DELETE(request())).status).toBe(200);
  expect(state.remove).toHaveBeenCalledWith("alice", "warcraftlogs", 1);
  state.remove.mockResolvedValue(false);
  expect((await DELETE(request())).status).toBe(409);
});

it("fails clearly without encryption configuration", async () => {
  state.available = false;
  expect(
    (await GET(new Request("https://slashwho.example/api/account/credentials")))
      .status
  ).toBe(503);
  expect(
    (
      await PUT(
        operatorMutation(
          {
            provider: "raiderio",
            values: { accessKey: "key" },
            replace: false,
            expectedVersion: 0,
            expectedAccountEmail: "a@example.test"
          },
          {},
          "PUT"
        )
      )
    ).status
  ).toBe(503);
});

it("returns only account credential metadata", async () => {
  const result = await GET(
    new Request("https://slashwho.example/api/account/credentials")
  );
  expect(result.status).toBe(200);
  expect(JSON.stringify(await result.json())).not.toContain("clientSecret");
  expect(state.summary).toHaveBeenCalledWith("alice");
});

it("requires explicit replacement and matching version", async () => {
  const body = {
    provider: "warcraftlogs",
    values: { clientId: "id", clientSecret: "secret-a" },
    replace: false,
    expectedVersion: 1,
    expectedAccountEmail: "a@example.test"
  };
  expect((await PUT(operatorMutation(body, {}, "PUT"))).status).toBe(409);
  expect(state.replace).not.toHaveBeenCalled();
  expect(
    (await PUT(operatorMutation({ ...body, replace: true }, {}, "PUT"))).status
  ).toBe(200);
  expect(state.replace).toHaveBeenCalledWith(
    "alice",
    "warcraftlogs",
    body.values,
    1
  );
});

it("rejects an old account form even when the new account has a matching key version", async () => {
  state.authenticate.mockResolvedValue({
    principal: {
      kind: "account",
      accountId: "bob",
      email: "b@example.test",
      role: "user",
      passwordChangeRequired: false
    }
  });
  const response = await PUT(
    operatorMutation(
      {
        provider: "warcraftlogs",
        values: { clientId: "a-id", clientSecret: "a-secret" },
        replace: true,
        expectedVersion: 1,
        expectedAccountEmail: "a@example.test"
      },
      {},
      "PUT"
    )
  );
  expect(response.status).toBe(409);
  expect(state.replace).not.toHaveBeenCalled();
});

it("rejects forced-change sessions and invalid provider pairs", async () => {
  expect(
    (
      await PUT(
        operatorMutation(
          {
            provider: "blizzard",
            values: { clientId: "id" },
            replace: false,
            expectedVersion: 0,
            expectedAccountEmail: "a@example.test"
          },
          {},
          "PUT"
        )
      )
    ).status
  ).toBe(400);
  state.authenticate.mockResolvedValue({
    principal: {
      kind: "account",
      accountId: "alice",
      role: "user",
      passwordChangeRequired: true
    }
  });
  expect(
    (await GET(new Request("https://slashwho.example/api/account/credentials")))
      .status
  ).toBe(401);
  expect(
    (await DELETE(operatorMutation({ provider: "warcraftlogs" }, {}, "DELETE")))
      .status
  ).toBe(401);
});
