import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function accountMailKey(key: Buffer): Buffer {
  if (key.length !== 32) throw new Error("invalid_credential_encryption_key");
  return Buffer.from(hkdfSync("sha256", key, "", "account-mail-outbox-v1", 32));
}

export function encryptAccountMail(message: string, key: Buffer): string {
  return encryptCredential(message, accountMailKey(key));
}

export function decryptAccountMail(ciphertext: string, key: Buffer): string {
  return decryptCredential(ciphertext, accountMailKey(key));
}

export function parseEncryptionKey(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("invalid_credential_encryption_key");
  }
  return Buffer.from(hex, "hex");
}

export function encryptCredential(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptCredential(ciphertext: string, key: Buffer): string {
  const raw = Buffer.from(ciphertext, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = raw.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8"
  );
}
