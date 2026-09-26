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
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error"
    }
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } }
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error"
    }
  },
  {
    // Tests stub repositories through loosely typed `vi.fn()` casts, whose
    // `mockImplementation` expects a void return. An async stub there is
    // the intended use, not a dropped promise.
    files: ["**/*.test.{ts,tsx,mts}"],
    rules: {
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false }
      ]
    }
  }
);
