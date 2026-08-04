export async function main(): Promise<void> {
  process.stdout.write(JSON.stringify({ event: "worker_boot" }) + "\n");
}

if (process.env.NODE_ENV !== "test") void main();
