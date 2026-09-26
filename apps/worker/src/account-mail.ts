import { decryptAccountMail } from "@slashwho/application";
import type { AccountMailRepository } from "@slashwho/database";
import { type Clock, elapsedMs, monotonicClock } from "./cycle-log";
import { errorName } from "./process-errors";

export type AccountMailConfig = {
  resendApiKey: string;
  accountEmailFrom: string;
  accountCredentialEncryptionKey: Buffer;
};

/** Named so a failed tick's `errorName` separates the provider from storage. */
export class AccountMailDeliveryError extends Error {
  constructor() {
    super("account_mail_delivery_failed");
  }
}

export async function sendResend(
  message: string,
  idempotencyKey: string,
  config: AccountMailConfig,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal
): Promise<void> {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Idempotency-Key": idempotencyKey,
        "Content-Type": "application/json"
      },
      body: message,
      signal: AbortSignal.any([
        AbortSignal.timeout(10_000),
        ...(signal ? [signal] : [])
      ])
    });
    // Never read or log provider response bodies, including errors.
    await response.body?.cancel();
    if (!response.ok) throw new Error();
  } catch {
    throw new AccountMailDeliveryError();
  }
}

export async function dispatchAccountMail(
  repository: AccountMailRepository,
  config: AccountMailConfig,
  options: {
    fetch?: typeof globalThis.fetch;
    at?: Date;
    signal?: AbortSignal;
  } = {}
): Promise<boolean> {
  const row = await repository.claimDue(
    options.at ?? new Date(),
    options.signal
  );
  options.signal?.throwIfAborted();
  if (!row) return false;
  const message = decryptAccountMail(
    row.encryptedMessage,
    config.accountCredentialEncryptionKey
  );
  await sendResend(
    message,
    row.idempotencyKey,
    config,
    options.fetch,
    options.signal
  );
  options.signal?.throwIfAborted();
  await repository.markSent(row.id, options.at ?? new Date(), options.signal);
  return true;
}

export class AccountMailStopTimeoutError extends Error {
  constructor() {
    super("account_mail_stop_timed_out");
  }
}

/** A serial polling loop; durable leases survive worker restarts. */
export function startAccountMailWorker(
  repository: AccountMailRepository,
  config: AccountMailConfig,
  logger?: { info(event: Record<string, unknown>): void },
  options: { clock?: Clock } = {}
): { stop(timeoutMs?: number): Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const controller = new AbortController();
  const clock = options.clock ?? monotonicClock;
  const tick = () => {
    pending = (async () => {
      const startedAt = clock();
      let delivered = false;
      try {
        delivered = await dispatchAccountMail(repository, config, {
          signal: controller.signal
        });
      } catch (error) {
        logger?.info({
          event: "account_mail_delivery_failed",
          durationMs: elapsedMs(clock, startedAt),
          errorName: errorName(error)
        });
      }
      // An idle tick claims nothing and recurs every five seconds, so only a
      // tick that sent something earns a record.
      if (delivered) {
        logger?.info({
          event: "account_mail_delivered",
          durationMs: elapsedMs(clock, startedAt)
        });
      }
      if (!stopped) {
        timer = setTimeout(tick, delivered ? 0 : 5_000);
        timer.unref();
      }
    })();
  };
  timer = setTimeout(tick, 0);
  timer.unref();
  return {
    async stop(timeoutMs = 30_000) {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new AccountMailStopTimeoutError()),
              timeoutMs
            );
          })
        ]);
      } finally {
        clearTimeout(deadline);
      }
    }
  };
}
