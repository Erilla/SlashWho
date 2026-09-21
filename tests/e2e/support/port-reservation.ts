import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ReservedPortPair = Readonly<{
  webPort: number;
  workerPort: number;
}>;

const releasePathVariable = "SLASHWHO_E2E_PORT_RESERVATION_RELEASE_PATH";
const statePathVariable = "SLASHWHO_E2E_PORT_RESERVATION_STATE_PATH";

export function reservePortPair(): ReservedPortPair {
  const directory = mkdtempSync(join(tmpdir(), "slashwho-e2e-ports-"));
  const statePath = join(directory, "state.json");
  const releasePath = join(directory, "release");
  const launcherPath = join(__dirname, "port-reservation-launcher.mjs");
  const output = execFileSync(
    process.execPath,
    [launcherPath, statePath, releasePath],
    {
      encoding: "utf8"
    }
  );
  const pair = JSON.parse(output) as ReservedPortPair;
  if (
    !Number.isSafeInteger(pair.webPort) ||
    !Number.isSafeInteger(pair.workerPort)
  ) {
    throw new Error("e2e_port_reservation_unavailable");
  }
  process.env[statePathVariable] = statePath;
  process.env[releasePathVariable] = releasePath;
  return pair;
}

export async function releasePortPair(): Promise<void> {
  const statePath = process.env[statePathVariable];
  const releasePath = process.env[releasePathVariable];
  if (!statePath || !releasePath || !existsSync(statePath)) return;

  writeFileSync(releasePath, "release");
  const deadline = Date.now() + 5_000;
  while (existsSync(statePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (existsSync(statePath)) {
    throw new Error(`e2e_port_reservation_release_timeout:${statePath}`);
  }
}
