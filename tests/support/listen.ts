import type { Server } from "node:http";

/**
 * Starts `server` on an ephemeral loopback port and returns the port.
 * `unavailableError` names the fake in the error thrown when the bound address
 * cannot be read back.
 */
export async function listen(
  server: Server,
  unavailableError: string
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(unavailableError);
  }
  return address.port;
}
