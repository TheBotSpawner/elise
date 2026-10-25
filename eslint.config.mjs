import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// External SDKs may only be imported from src/infrastructure.
const externalSdks = ["@supabase/*", "@trigger.dev/*", "@openai/*", "openai"];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", ["parent", "sibling", "index"]],
          pathGroups: [{ pattern: "@/**", group: "internal" }],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      // ADR-075: ELISE's own dialogs (useConfirm), never the browser's or Windows' native ones.
      "no-restricted-globals": [
        "error",
        ...["confirm", "alert", "prompt"].map((name) => ({
          name,
          message: "Use useConfirm() / ELISE's dialogs, never native popups.",
        })),
      ],
      "no-restricted-properties": [
        "error",
        ...["confirm", "alert", "prompt"].map((property) => ({
          object: "window",
          property,
          message: "Use useConfirm() / ELISE's dialogs, never native popups.",
        })),
      ],
    },
  },
  {
    files: ["src/**"],
    // src/trigger holds the background runtime's entry points (like src/app for HTTP).
    ignores: ["src/infrastructure/**", "src/trigger/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: externalSdks,
              message: "External SDKs live in src/infrastructure behind adapters.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/core/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...externalSdks, "next", "next/*", "react", "react-dom"],
              message: "src/core must stay framework- and provider-independent.",
            },
            {
              group: ["@/infrastructure/*", "@/features/*", "@/components/*", "@/app/*"],
              message: "src/core must not depend on outer layers.",
            },
          ],
        },
      ],
    },
  },
  {
    // ELISE Desktop (ADR-081): its own tsconfig resolves Electron and the shared @/ source.
    files: ["desktop/**"],
    settings: {
      "import/core-modules": ["electron"],
      "import/internal-regex": "^@/",
      "import/resolver": { typescript: { project: "desktop/tsconfig.json" }, node: true },
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".trigger/**",
    // Claude Design visual reference: development material, never imported or served.
    "design-reference/**",
    // ELISE Desktop build output.
    "desktop/.vite/**",
    "desktop/out/**",
  ]),
]);

export default eslintConfig;
