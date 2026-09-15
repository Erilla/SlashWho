import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dockerfilePath = fileURLToPath(
  new URL("../../../../Dockerfile.web", import.meta.url)
);

describe("web production image", () => {
  it("copies public brand assets into the standalone runtime", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");

    expect(dockerfile).toContain(
      "COPY --from=build --chown=node:node /workspace/apps/web/public /app/apps/web/public"
    );
  });
});
