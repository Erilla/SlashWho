import { describe, expect, it, vi } from "vitest";

import { parseOperatorOperation, runOperatorOperation } from "./operators.mts";

describe("operator lifecycle command", () => {
  it("parses provision without accepting a credential on the command line", () => {
    expect(parseOperatorOperation(["--", "provision", "Admin"])).toEqual({
      command: "provision",
      login: "Admin"
    });
    expect(() =>
      parseOperatorOperation(["provision", "Admin", "--credential", "secret"])
    ).toThrow("operator_credential_cli_forbidden");
  });

  it("provisions a canonical operator and records only the lifecycle event", async () => {
    const provision = vi.fn().mockResolvedValue({ id: "operator-id" });
    const appendEvent = vi.fn().mockResolvedValue(undefined);
    const result = await runOperatorOperation(
      { command: "provision", login: "Admin" },
      {
        repository: { provision, appendEvent },
        readCredential: async () => "x".repeat(20),
        hashCredential: async () => ({
          passwordHash: "hash",
          passwordSalt: "salt",
          scryptVersion: 1,
          scryptCost: 16_384
        }),
        now: () => new Date("2026-01-01T00:00:00Z")
      }
    );
    expect(result).toEqual({ action: "provision", operatorId: "operator-id" });
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalLogin: "admin",
        displayLogin: "Admin"
      })
    );
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "operator-id",
        action: "provision",
        outcome: "success"
      })
    );
  });
});
