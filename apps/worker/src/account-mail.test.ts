import { describe, expect, it, vi } from "vitest";
import { decryptCredential, encryptAccountMail } from "@slashwho/application";
import type { AccountMailRepository, MailOutboxRow } from "@slashwho/database";
import {
  dispatchAccountMail,
  sendResend,
  startAccountMailWorker
} from "./account-mail";

const key = Buffer.alloc(32, 7);
const config = {
  resendApiKey: "secret",
  accountEmailFrom: "SlashWho <accounts@example.com>",
  accountCredentialEncryptionKey: key
};
const message = JSON.stringify({
  from: config.accountEmailFrom,
  to: "user@example.com",
  subject: "Verify",
  text: "https://example.com/verify?token=secret"
});

describe("account mail", () => {
  it("encrypts link contents with an independent authenticated key", () => {
    const encrypted = encryptAccountMail(message, key);
    expect(encrypted).not.toContain("secret");
    expect(() => decryptCredential(encrypted, key)).toThrow();
  });

  it("retries the identical message and idempotency key after uncertain acceptance", async () => {
    const at = new Date("2026-09-23T12:00:00Z");
    const row: MailOutboxRow = {
      id: "mail-1",
      idempotencyKey: "mail-1",
      encryptedMessage: encryptAccountMail(message, key),
      attempt: 1,
      expiresAt: new Date(at.getTime() + 3600000)
    };
    let sent = false;
    let failMark = true;
    const repository: AccountMailRepository = {
      issue: vi.fn(),
      claimDue: async () => (sent ? null : row),
      markSent: async () => {
        if (failMark) {
          failMark = false;
          throw new Error("database disconnected");
        }
        sent = true;
      }
    };
    const requests: RequestInit[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      requests.push(init!);
      return new Response("", { status: 200 });
    });
    await expect(
      dispatchAccountMail(repository, config, { fetch, at })
    ).rejects.toThrow();
    await dispatchAccountMail(repository, config, { fetch, at });
    expect(sent).toBe(true);
    expect(requests.map((request) => request.body)).toEqual([message, message]);
    expect(
      requests.map((request) =>
        new Headers(request.headers).get("Idempotency-Key")
      )
    ).toEqual(["mail-1", "mail-1"]);
  });

  it("does not expose provider response details", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("secret recipient", { status: 429 })
    );
    await expect(sendResend(message, "mail-1", config, fetch)).rejects.toThrow(
      "account_mail_delivery_failed"
    );
    const network = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("secret response");
    });
    await expect(
      sendResend(message, "mail-1", config, network)
    ).rejects.toThrow("account_mail_delivery_failed");
  });

  it("polls again after a network failure and drains without logging secrets", async () => {
    vi.useFakeTimers();
    let sent = false;
    const repository: AccountMailRepository = {
      issue: vi.fn(),
      claimDue: async () =>
        sent
          ? null
          : {
              id: "mail-1",
              idempotencyKey: "mail-1",
              attempt: 1,
              encryptedMessage: encryptAccountMail(message, key),
              expiresAt: new Date(Date.now() + 3600000)
            },
      markSent: async () => {
        sent = true;
      }
    };
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, request: RequestInit) => {
      requests.push(request);
      if (requests.length === 1) throw new Error("secret recipient token");
      return new Response("", { status: 200 });
    });
    const logger = { info: vi.fn() };
    const worker = startAccountMailWorker(repository, config, logger);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toBe(false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sent).toBe(true);
      expect(requests.map((request) => request.body)).toEqual([
        message,
        message
      ]);
      expect(logger.info.mock.calls).toEqual([
        [{ event: "account_mail_delivery_failed" }]
      ]);
      await worker.stop();
      await vi.advanceTimersByTimeAsync(60000);
      expect(requests).toHaveLength(2);
    } finally {
      await worker.stop();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
