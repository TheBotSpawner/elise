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
    },
  },
  {
    files: ["src/**"],
    ignores: ["src/infrastructure/**"],
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
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".trigger/**",
  ]),
]);

export default eslintConfig;
