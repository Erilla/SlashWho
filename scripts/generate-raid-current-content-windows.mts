import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  fetchRaidCurrentContentWindows,
  isDirectExecution
} from "./raid-current-content-windows.mts";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLocaleLowerCase("en-US")}_required`);
  return value;
}

async function main() {
  const output = requiredEnvironment(
    "SLASHWHO_RAID_CURRENT_CONTENT_WINDOW_OUTPUT"
  );
  const baseUrl = new URL(
    process.env.SLASHWHO_RAIDER_IO_BASE_URL?.trim() || "https://raider.io"
  );
  const windows = await fetchRaidCurrentContentWindows({
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          // Raider.IO rejects requests without an identifying agent.
          "user-agent": "SlashWho raid current-content window generator"
        }
      }),
    baseUrl
  });
  const snapshot = {
    source: "raiderio-raiding-static-data",
    generatedAt: new Date().toISOString(),
    windows
  };
  const outputPath = resolve(output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify({
      output: outputPath,
      windowCount: Object.keys(windows).length
    })
  );
}

if (isDirectExecution(import.meta.url, process.argv[1] ?? "")) {
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "raid_current_content_windows_failed"
    );
    process.exitCode = 1;
  });
}
