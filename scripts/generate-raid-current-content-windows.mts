import { requiredEnvironment, runIfMain } from "./lib/cli.mts";
import { writeSnapshot } from "./lib/snapshot.mts";
import { fetchRaidCurrentContentWindows } from "./raid-current-content-windows.mts";

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
  const outputPath = await writeSnapshot(output, {
    source: "raiderio-raiding-static-data",
    generatedAt: new Date().toISOString(),
    windows
  });
  console.log(
    JSON.stringify({
      output: outputPath,
      windowCount: Object.keys(windows).length
    })
  );
}

runIfMain(import.meta.url, main, "raid_current_content_windows_failed");
