import type { DiscoveryLogger } from "@slashwho/application";

export const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;

export type WebhookOptions = {
  logger?: DiscoveryLogger;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /**
   * What a failed delivery logs: an `event` and any fixed context, to which
   * the failure kind and, for a refusal, the HTTP status are added. Never the
   * URL -- a webhook's secret is in its path.
   */
  failureRecord: Readonly<Record<string, unknown>>;
};

/**
 * POSTs `body` to a webhook as JSON, best effort: delivery is bounded by the
 * timeout and a failure is logged rather than thrown, because every webhook
 * this worker calls is a convenience for whoever is watching, never a
 * dependency of the work that triggered it.
 */
export async function postWebhook(
  url: string,
  body: unknown,
  options: WebhookOptions
): Promise<void> {
  const fetch = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(
        options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS
      )
    });
    if (!response.ok) {
      options.logger?.info({
        ...options.failureRecord,
        failure: "http_status",
        status: response.status
      });
    }
  } catch {
    options.logger?.info({
      ...options.failureRecord,
      failure: "network_or_timeout"
    });
  }
}
