import { safeApiErrorSchema } from "@slashwho/contracts";

/**
 * What to tell the visitor when an API route refused a request: a rate limit
 * with its wait when the route gave one, then the route's own error message,
 * then `fallback`. `subject` names what was rate limited, e.g. "searches".
 */
export function refusalMessage(
  response: Response,
  body: unknown,
  fallback: string,
  subject = "requests"
): string {
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    return retryAfter && /^\d+$/.test(retryAfter)
      ? `Too many ${subject}. Try again in ${retryAfter} seconds.`
      : `Too many ${subject}. Please try again shortly.`;
  }
  const parsed = safeApiErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.error.message : fallback;
}
