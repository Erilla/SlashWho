import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  parseOperatorOperation,
  readHiddenCredential,
  runOperatorOperation
} from "./operators.mts";

describe("operator lifecycle command", () => {
  it("reads a credential without echo and restores terminal mode", async () => {
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode: vi.fn()
    });
    const output = { write: vi.fn() };
    const credential = readHiddenCredential({ input, output });
    input.emit("data", Buffer.from("secret\r"));
    await expect(credential).resolves.toBe("secret");
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(output.write).toHaveBeenCalledWith("Credential: ");
    expect(output.write).not.toHaveBeenCalledWith("secret");
  });

  it("parses provision without accepting a credential on the command line", () => {
    expect(parseOperatorOperation(["--", "provision", "Admin"])).toEqual({
      command: "provision",
      login: "Admin"
    });
    expect(() =>
      parseOperatorOperation(["provision", "Admin", "--credential", "secret"])
    ).toThrow("operator_credential_cli_forbidden");
    expect(() =>
      parseOperatorOperation(["provision", "Admin", "secret"])
    ).toThrow("operator_arguments_invalid");
  });

  it("provisions a canonical operator without duplicating its transactional audit event", async () => {
    const provision = vi.fn().mockResolvedValue({ id: "operator-id" });
    const result = await runOperatorOperation(
      { command: "provision", login: "Admin" },
      {
        repository: {
          provision,
          rotateCredential: vi.fn(),
          disable: vi.fn(),
          list: vi.fn()
        },
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
  });
});
