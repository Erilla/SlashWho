import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("agent skills", () => {
  // Claude Code loads .claude/skills and Codex loads .agents/skills. The two
  // copies are byte-for-byte the same file; edit one, then copy it over the
  // other.
  it("keeps the issue-pickup copies for Claude Code and Codex identical", () => {
    expect(read(".claude/skills/issue-pickup/SKILL.md")).toBe(
      read(".agents/skills/issue-pickup/SKILL.md")
    );
  });
});
