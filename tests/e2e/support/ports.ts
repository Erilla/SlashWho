const MINIMUM_PORT = 30_000;
const PORT_RANGE = 10_000;

export function portsForWorkspace(workspace: string): Readonly<{
  webPort: number;
  workerPort: number;
}> {
  let hash = 0;
  for (const character of workspace) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  const webPort = MINIMUM_PORT + (hash % PORT_RANGE);
  return { webPort, workerPort: webPort + 1 };
}

const ports = portsForWorkspace(process.cwd());

export const e2eWebPort = ports.webPort;
export const e2eWorkerPort = ports.workerPort;
export const e2eWebBaseUrl = `http://127.0.0.1:${e2eWebPort}`;
export const e2eWorkerBaseUrl = `http://127.0.0.1:${e2eWorkerPort}`;
