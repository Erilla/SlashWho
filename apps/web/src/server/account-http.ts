/** Strict, bounded JSON parser shared by account mutations. */
export async function accountMutation(
  request: Request,
  origin: string
): Promise<Record<string, unknown> | null> {
  if (
    request.method !== "POST" ||
    request.headers.get("origin") !== origin ||
    request.headers.get("sec-fetch-site") !== "same-origin" ||
    request.headers.get("authorization") !== null ||
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export const accountReply = (message: string, status = 200) =>
  Response.json(
    { message },
    { status, headers: { "cache-control": "no-store" } }
  );

export const accountFailure = (message: string, status = 400) =>
  accountReply(message, status);
