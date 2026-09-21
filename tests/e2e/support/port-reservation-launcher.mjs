import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const [statePath, releasePath] = process.argv.slice(2);
const holder = spawn(
  process.execPath,
  [join(directory, "port-reservation-holder.mjs"), statePath, releasePath],
  { detached: true, stdio: "ignore" }
);
holder.unref();

const deadline = Date.now() + 5_000;
const interval = setInterval(() => {
  if (existsSync(statePath)) {
    process.stdout.write(readFileSync(statePath));
    clearInterval(interval);
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    clearInterval(interval);
    process.exit(1);
  }
}, 10);
