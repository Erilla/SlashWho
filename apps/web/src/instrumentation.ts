export async function register(): Promise<void> {
  // The logger and process listeners are Node-only; the edge runtime has
  // neither pino's streams nor process events.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ installProcessErrorHandlers }, { webLogger }] = await Promise.all([
    import("./server/process-errors"),
    import("./server/logger")
  ]);
  installProcessErrorHandlers(process, webLogger);
}
