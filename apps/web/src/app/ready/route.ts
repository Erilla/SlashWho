import { getContainer } from "../../server/container";

export async function GET(): Promise<Response> {
  const ready = await getContainer()
    .then((container) => container.ready())
    .catch(() => false);
  return Response.json(
    { status: ready ? "ready" : "not_ready" },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } }
  );
}
