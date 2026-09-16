import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.claude/worktrees/**",
      "**/.next/**",
      "**/.worktrees/**",
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended
);
