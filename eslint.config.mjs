import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // PlankSpace is a sub-mode of the RobinWood design system (DESIGN.md).
  // Tailwind's stock `amber-*` ramp is the shadow palette that keeps
  // creeping back in; the detector can't see class-based colours, so this
  // is the guard. Use gold-* / wood-* / cream / line tokens instead.
  {
    files: ["integrations/plankspace-app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector: "Literal[value=/\\b(bg|text|border|from|to|via|ring|shadow|fill|stroke)-amber-\\d/]",
          message:
            "Use DESIGN.md tokens (gold-*, wood-*, cream, line) instead of Tailwind amber-* in PlankSpace.",
        },
        {
          selector: "TemplateElement[value.raw=/\\b(bg|text|border|from|to|via|ring|shadow|fill|stroke)-amber-\\d/]",
          message:
            "Use DESIGN.md tokens (gold-*, wood-*, cream, line) instead of Tailwind amber-* in PlankSpace.",
        },
      ],
    },
  },
]);

export default eslintConfig;
