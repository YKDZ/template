import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "#template-builtin-presets";
import { renderNewProject } from "#template-core/renderer";

type Tsconfig = {
  readonly compilerOptions?: Readonly<Record<string, unknown>>;
  readonly extends?: string | readonly string[];
  readonly files?: readonly string[];
  readonly references?: readonly { readonly path: string }[];
};

const policyOptions = {
  exactOptionalPropertyTypes: true,
  forceConsistentCasingInFileNames: true,
  isolatedModules: true,
  noEmitOnError: true,
  noFallthroughCasesInSwitch: true,
  noImplicitOverride: true,
  noImplicitReturns: true,
  noUncheckedIndexedAccess: true,
  skipLibCheck: false,
  strict: true,
  verbatimModuleSyntax: true,
} as const;

async function tsconfigPaths(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (
        entry.isFile() &&
        /^tsconfig(?:\.[^.]+)?\.json$/u.test(entry.name)
      ) {
        paths.push(entryPath);
      }
    }
  }
  await visit(root);
  return paths.toSorted();
}

async function readTsconfig(configPath: string): Promise<Tsconfig> {
  return JSON.parse(await readFile(configPath, "utf8")) as Tsconfig;
}

async function localExtendsChain(
  configPath: string,
  seen = new Set<string>(),
): Promise<ReadonlySet<string>> {
  const resolvedPath = path.resolve(configPath);
  if (seen.has(resolvedPath)) return seen;
  seen.add(resolvedPath);
  const config = await readTsconfig(resolvedPath);
  const inherited = Array.isArray(config.extends)
    ? config.extends
    : config.extends === undefined
      ? []
      : [config.extends];
  for (const reference of inherited) {
    if (!reference.startsWith(".")) {
      seen.add(reference);
      continue;
    }
    const parentPath = path.resolve(path.dirname(resolvedPath), reference);
    await localExtendsChain(parentPath, seen);
  }
  return seen;
}

describe("Generated Repository TypeScript policy", () => {
  it.each(
    builtInPresetRegistry.all().map((definition) => definition.metadata.name),
  )(
    "%s inherits one strict policy with explicit ecosystem exceptions",
    async (presetName) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), `template-typescript-policy-${presetName}-`),
      );
      const targetDir = path.join(workspace, "repository");
      try {
        const definition = builtInPresetRegistry.require(presetName);
        const plan = planGeneratedRepositoryInitialization({
          definition,
          context: createGenerationContext({
            targetDir,
            scope: "policy",
            toolchain: {
              nodeLtsMajor: "24",
              packageManagerPin: "pnpm@11.11.0",
            },
          }),
        });
        await renderNewProject({
          targetRoot: targetDir,
          operations: [...plan.operations],
        });

        const configPackageName = "@policy/typescript-config";
        const configReference = `${configPackageName}/base.json`;
        const baselinePath = path.join(
          targetDir,
          "packages/typescript-config/base.json",
        );
        expect(await readTsconfig(baselinePath)).toEqual({
          compilerOptions: policyOptions,
        });
        expect(plan.blueprint.packages).toContainEqual({
          name: configPackageName,
          path: "packages/typescript-config",
          role: "shared-library",
        });

        for (const configPath of await tsconfigPaths(targetDir)) {
          const config = await readTsconfig(configPath);
          const relativePath = path.relative(targetDir, configPath);
          const isSolutionConfig =
            config.compilerOptions === undefined &&
            config.files?.length === 0 &&
            config.references !== undefined;
          if (!isSolutionConfig) {
            const chain = await localExtendsChain(configPath);
            expect({
              inheritsPolicy:
                chain.has(path.resolve(baselinePath)) ||
                chain.has(configReference),
              relativePath,
            }).toEqual({ inheritsPolicy: true, relativePath });
          }

          const repeatedPolicyOptions = Object.keys(
            config.compilerOptions ?? {},
          ).filter((option) => Object.hasOwn(policyOptions, option));
          const inherited = Array.isArray(config.extends)
            ? config.extends
            : config.extends === undefined
              ? []
              : [config.extends];
          const allowedOverrides = [
            ...(config.compilerOptions?.exactOptionalPropertyTypes === false &&
            inherited.includes("@vue/tsconfig/tsconfig.dom.json")
              ? ["exactOptionalPropertyTypes"]
              : []),
            ...(config.compilerOptions?.skipLibCheck === true &&
            config.compilerOptions.moduleResolution === "bundler"
              ? ["skipLibCheck"]
              : []),
          ];
          expect({ relativePath, repeatedPolicyOptions }).toEqual({
            relativePath,
            repeatedPolicyOptions: allowedOverrides,
          });
        }
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
