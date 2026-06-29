import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const generatedBy = {
  packageName: "@ykdz/template",
  version: "0.0.0",
  command: "template init --preset ts-lib"
};

type FileSpec = {
  path: string;
  content: string;
};

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function projectNameFromDir(targetDir: string): string {
  return path.basename(path.resolve(targetDir));
}

async function assertNewOrEmptyDirectory(targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(targetDir);

  if (entries.length > 0) {
    throw new Error(`Target directory is not empty: ${targetDir}`);
  }
}

function filesForTsLib(targetDir: string): FileSpec[] {
  const projectName = projectNameFromDir(targetDir);

  return [
    {
      path: "package.json",
      content: `{
  "name": "${projectName}",
  "version": "0.0.0",
  "private": true,
  "files": [
    "dist"
  ],
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json && tsc-alias -p tsconfig.json",
    "check": "pnpm run typecheck && pnpm run lint && pnpm run format:check",
    "fix": "pnpm run format:write && pnpm run lint:fix",
    "format:check": "oxfmt --check .",
    "format:write": "oxfmt --write .",
    "lint": "oxlint . --deny-warnings",
    "lint:fix": "oxlint . --fix --deny-warnings",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "oxfmt": "catalog:",
    "oxlint": "catalog:",
    "tsc-alias": "catalog:",
    "typescript": "catalog:"
  },
  "engines": {
    "node": ">=22.0.0"
  },
  "packageManager": "pnpm@11.8.0"
}
`
    },
    {
      path: "pnpm-workspace.yaml",
      content: [
        "packages:",
        "  - .",
        "",
        "catalog:",
        '  "@types/node": ^24.0.0',
        "  oxfmt: ^0.56.0",
        "  oxlint: ^1.71.0",
        "  tsc-alias: ^1.8.17",
        "  typescript: ^5.8.0",
        ""
      ].join("\n")
    },
    {
      path: "tsconfig.json",
      content: `{
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmitOnError": true,
    "outDir": "dist",
    "paths": {
      "@/*": ["./src/*"]
    },
    "rootDir": "src",
    "skipLibCheck": false,
    "strict": true,
    "target": "ES2022",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
`
    },
    {
      path: ".oxlintrc.json",
      content: `{
  "categories": {
    "correctness": "error",
    "suspicious": "error"
  },
  "plugins": ["typescript", "oxc"]
}
`
    },
    {
      path: ".oxfmtrc.json",
      content: json({
        printWidth: 100,
        singleQuote: false,
        trailingComma: "none"
      })
    },
    {
      path: ".gitignore",
      content: ["node_modules", "dist", ".env", ""].join("\n")
    },
    {
      path: "src/index.ts",
      content: [
        "export type Greeting = {",
        "  message: string;",
        "};",
        "",
        "export function greet(name: string): Greeting {",
        "  return { message: `Hello, ${name}` };",
        "}",
        ""
      ].join("\n")
    },
    {
      path: ".project-kit/blueprint.json",
      content: json({
        schemaVersion: 1,
        preset: "ts-lib",
        packageManager: "pnpm",
        projectKind: "single-package",
        features: [
          "pnpm-catalog",
          "oxc-format-lint",
          "strict-typescript",
          "root-check",
          "fix-command",
          "devcontainer",
          "github-actions",
          "dependabot"
        ]
      })
    },
    {
      path: ".project-kit/generated-by.json",
      content: json(generatedBy)
    },
    {
      path: ".devcontainer/devcontainer.json",
      content: `{
  "name": "${projectName} development",
  "image": "mcr.microsoft.com/devcontainers/typescript-node:22",
  "postCreateCommand": "corepack enable && pnpm install",
  "customizations": {
    "vscode": {
      "extensions": ["oxc.oxc-vscode", "dbaeumer.vscode-eslint"]
    }
  }
}
`
    },
    {
      path: ".github/workflows/check.yml",
      content: [
        "name: Check",
        "",
        "on:",
        "  pull_request:",
        "  push:",
        "    branches:",
        "      - main",
        "",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: pnpm/action-setup@v4",
        "        with:",
        "          version: 11.8.0",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          node-version: 22",
        "          cache: pnpm",
        "      - run: pnpm install",
        "      - run: pnpm run check",
        ""
      ].join("\n")
    },
    {
      path: ".github/dependabot.yml",
      content: [
        "version: 2",
        "updates:",
        "  - package-ecosystem: npm",
        "    directory: /",
        "    schedule:",
        "      interval: weekly",
        "  - package-ecosystem: github-actions",
        "    directory: /",
        "    schedule:",
        "      interval: weekly",
        ""
      ].join("\n")
    }
  ];
}

export async function initTsLibProject(targetDir: string): Promise<void> {
  await assertNewOrEmptyDirectory(targetDir);

  for (const file of filesForTsLib(targetDir)) {
    const filePath = path.join(targetDir, file.path);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, "utf8");
  }
}
