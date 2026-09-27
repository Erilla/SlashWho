import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const typeScriptFiles = ["**/*.{ts,tsx,mts,cts}"];
const testFiles = ["**/*.test.{ts,tsx,mts}", "**/*-test-fixture.ts"];

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
  // Type-aware rules cannot load on plain JavaScript such as this file, which
  // has no type information, so the preset is scoped to TypeScript.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: typeScriptFiles
  })),
  {
    files: typeScriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } }
      ],
      // Handing on a rejection the code did not create -- a caught error, an
      // `AbortSignal`'s reason -- is propagation, not a new non-Error
      // rejection. This matches `only-throw-error`'s defaults for `throw`.
      "@typescript-eslint/prefer-promise-reject-errors": [
        "error",
        { allowThrowingAny: true, allowThrowingUnknown: true }
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error"
    }
  },
  {
    // Discovery aborts a traversal by throwing a `{ kind: "schema_drift" }`
    // sentinel that its own catch reads structurally, as it reads upstream
    // failures (see `isUpstreamFailure`). The sentinel is the design, not a
    // stray non-Error throw.
    files: [
      "packages/domain/src/discovery.ts",
      "packages/domain/src/fingerprint-discovery.ts"
    ],
    rules: {
      "@typescript-eslint/only-throw-error": "off"
    }
  },
  {
    files: testFiles,
    rules: {
      // Tests stub repositories through loosely typed `vi.fn()` casts, whose
      // `mockImplementation` expects a void return. An async stub there is
      // the intended use, not a dropped promise.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false }
      ],
      // Async fakes stand in for async interfaces and mostly resolve at once.
      "@typescript-eslint/require-await": "off",
      // `expect(repository.method)` asserts on a `vi.fn()`, which never reads
      // `this`.
      "@typescript-eslint/unbound-method": "off",
      // Fetch fakes stringify the `RequestInfo | URL` they are handed; a test
      // only ever hands them strings and URLs.
      "@typescript-eslint/no-base-to-string": "off",
      // Tests throw and reject plain objects on purpose, to prove the code
      // under test reads failures structurally.
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      // `any` in a test comes from `vi.fn()` mocks, `mock.calls` and parsed
      // response bodies, and the assertion that reads it is the check. Typing
      // each one would add casts, not coverage.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off"
    }
  }
);
