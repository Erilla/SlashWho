import { describe, expect, it, vi } from "vitest";

import { postWebhook } from "./webhook";

const failureRecord = { event: "test_delivery_failed", alertEvent: "x" };

describe("postWebhook", () => {
  it("posts the body as JSON under a timeout", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const logger = { info: vi.fn() };

    await postWebhook(
      "https://example.test/hook",
      { content: "hello" },
      { fetch, logger, failureRecord }
    );

    expect(fetch).toHaveBeenCalledWith("https://example.test/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
      signal: expect.any(AbortSignal)
    });
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("logs a refusal with its status, and never the URL", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 }));
    const logger = { info: vi.fn() };

    await postWebhook(
      "https://example.test/hook/secret",
      {},
      { fetch, logger, failureRecord }
    );

    expect(logger.info).toHaveBeenCalledWith({
      ...failureRecord,
      failure: "http_status",
      status: 404
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("secret");
  });

  it("logs a network failure or timeout rather than throwing", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const logger = { info: vi.fn() };

    await expect(
      postWebhook(
        "https://example.test/hook",
        {},
        { fetch, logger, failureRecord }
      )
    ).resolves.toBeUndefined();

    expect(logger.info).toHaveBeenCalledWith({
      ...failureRecord,
      failure: "network_or_timeout"
    });
  });
});
