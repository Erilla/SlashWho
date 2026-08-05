import { PassThrough } from "node:stream";
import { expect, it } from "vitest";

import { createWebLogger } from "./logger";

it("logs only operational fields and redacts request and upstream secrets", async () => {
  // Break caught: HTTP diagnostics could persist credentials or private lookup data.
  const marker = "UNIQUE_WEB_PRIVATE_MARKER_f353d8";
  const output = new PassThrough();
  let captured = "";
  output.on("data", (chunk) => {
    captured += chunk.toString();
  });
  const logger = createWebLogger(output);

  logger.info({
    endpoint: "search",
    status: 202,
    durationMs: 12,
    count: 3,
    authorization: marker,
    cookie: marker,
    request: { body: { characterUrl: marker } },
    battleTag: marker,
    discordProfile: marker,
    profileGuess: marker,
    rawUpstreamBody: marker
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(captured).toContain('"endpoint":"search"');
  expect(captured).toContain('"status":202');
  expect(captured).not.toContain(marker);
});
