import { createServer } from "node:net";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { clearInterval, setInterval, setTimeout } from "node:timers";

const [statePath, releasePath] = process.argv.slice(2);

function listen() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  const [webServer, workerServer] = await Promise.all([listen(), listen()]);
  const webPort = webServer.address().port;
  const workerPort = workerServer.address().port;
  writeFileSync(statePath, JSON.stringify({ webPort, workerPort }));

  const release = async () => {
    clearInterval(interval);
    await Promise.all([close(webServer), close(workerServer)]);
    rmSync(statePath, { force: true });
  };
  const interval = setInterval(() => {
    if (!existsSync(releasePath)) return;
    void release();
  }, 10);
  setTimeout(() => {
    void release();
  }, 60_000).unref();
}

void main();
