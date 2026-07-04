import { defineConfig } from "oxlint";

export default defineConfig({
  options: {
    typeAware: true,
  },
  categories: {
    correctness: "error",
    suspicious: "warn",
  },
  plugins: [
    "eslint",
    "typescript",
    "unicorn",
    "oxc",
    "node",
    "import",
    "vitest",
    "promise",
    "vue",
  ],
  rules: {
    "typescript/consistent-return": "off",
    "import/no-unassigned-import": ["warn", { allow: ["**/*.css"] }],
    "typescript/no-misused-promises": "error",
    "typescript/no-unsafe-argument": "warn",
    "typescript/no-unsafe-assignment": "warn",
    "typescript/no-unsafe-call": "warn",
    "typescript/no-unsafe-member-access": "warn",
    "typescript/no-unsafe-return": "warn",
    "typescript/switch-exhaustiveness-check": "error",
    "vitest/expect-expect": "off",
    "vitest/no-conditional-expect": "off",
    "vitest/require-to-throw-message": "off",
  },
});
