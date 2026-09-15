import { describe, expect, it } from "vitest";
import {
  decryptCredential,
  encryptCredential,
  parseEncryptionKey
} from "./credential-encryption";

const key = parseEncryptionKey("a".repeat(64));

describe("credential-encryption", () => {
  it("round-trips a plaintext credential", () => {
    const ciphertext = encryptCredential("super-secret-client-id", key);
    expect(ciphertext).not.toContain("super-secret-client-id");
    expect(decryptCredential(ciphertext, key)).toBe("super-secret-client-id");
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => parseEncryptionKey("too-short")).toThrow(
      "invalid_credential_encryption_key"
    );
  });

  it("fails to decrypt with the wrong key", () => {
    const otherKey = parseEncryptionKey("b".repeat(64));
    const ciphertext = encryptCredential("value", key);
    expect(() => decryptCredential(ciphertext, otherKey)).toThrow();
  });
});
