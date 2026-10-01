import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

// Claude Code loads .claude/skills and Codex loads .agents/skills. Each pair
// is byte-for-byte the same file; edit one, then copy it over the other.
const mirrored = [
  "issue-pickup/SKILL.md",
  "manager/SKILL.md",
  "manager/references/lessons.md",
  "manager/references/monitors.md",
  "manager/references/review-brief.md"
];

describe("agent skills", () => {
  it.each(mirrored)(
    "keeps the Claude Code and Codex copies of %s identical",
    (file) => {
      expect(read(`.agents/skills/${file}`)).toBe(
        read(`.claude/skills/${file}`)
      );
    }
  );
});
