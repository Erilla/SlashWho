import { expect, it } from "vitest";

import { refusalMessage } from "./refusal-message";

it("names the wait a rate limit gave, in the caller's words", () => {
  const response = new Response(null, {
    status: 429,
    headers: { "retry-after": "30" }
  });
  expect(refusalMessage(response, null, "Failed.", "searches")).toBe(
    "Too many searches. Try again in 30 seconds."
  );
});

it("does not quote a Retry-After that is not a number of seconds", () => {
  const response = new Response(null, {
    status: 429,
    headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }
  });
  expect(refusalMessage(response, null, "Failed.")).toBe(
    "Too many requests. Please try again shortly."
  );
});

it("prefers the route's own error message to the fallback", () => {
  const response = new Response(null, { status: 400 });
  expect(
    refusalMessage(
      response,
      { error: { code: "invalid_character_url", message: "Not a character." } },
      "Failed."
    )
  ).toBe("Not a character.");
  expect(refusalMessage(response, null, "Failed.")).toBe("Failed.");
});
