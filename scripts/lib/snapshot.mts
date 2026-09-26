import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Write `snapshot` as formatted JSON, returning the absolute output path. */
export async function writeSnapshot(
  output: string,
  snapshot: unknown
): Promise<string> {
  const outputPath = resolve(output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return outputPath;
}
