import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  builtInPresetRegistry,
  createGenerationContext,
  planGeneratedRepositoryInitialization,
} from "@ykdz/template-builtin-presets";
import { releaseToolchainSnapshot } from "@ykdz/template-core/release-toolchain-snapshot";
import { renderNewProject } from "@ykdz/template-core/renderer";

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

void describe("Generated Repository TypeScript policy", () => {
  for (const definition of builtInPresetRegistry.all()) {
    const presetName = definition.metadata.name;
    void describe(`${presetName} generated repository TypeScript policy`, () => {
      void it("inherits one strict policy with explicit ecosystem exceptions", async () => {
        const workspace = await mkdtemp(
          path.join(tmpdir(), `template-typescript-policy-${presetName}-`),
        );
        const targetDir = path.join(workspace, "repository");
        try {
          const plan = planGeneratedRepositoryInitialization({
            definition,
            context: createGenerationContext({
              targetDir,
              defaultPackageScope: "policy",
              toolchain: {
                nodeLtsMajor: "24",
                packageManagerPin: "pnpm@11.11.0",
                nodeVersion: releaseToolchainSnapshot.nodeVersion,
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
          assert.deepStrictEqual(await readTsconfig(baselinePath), {
            compilerOptions: policyOptions,
          });
          assert.ok(
            plan.blueprint.packages.some(
              (pkg) =>
                pkg.name === configPackageName &&
                pkg.path === "packages/typescript-config" &&
                pkg.role === "shared-library",
            ),
          );

          for (const configPath of await tsconfigPaths(targetDir)) {
            const config = await readTsconfig(configPath);
            const relativePath = path.relative(targetDir, configPath);
            const isSolutionConfig =
              config.compilerOptions === undefined &&
              config.files?.length === 0 &&
              config.references !== undefined;
            if (!isSolutionConfig) {
              const chain = await localExtendsChain(configPath);
              assert.deepStrictEqual(
                {
                  inheritsPolicy:
                    chain.has(path.resolve(baselinePath)) ||
                    chain.has(configReference),
                  relativePath,
                },
                { inheritsPolicy: true, relativePath },
              );
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
              ...(config.compilerOptions?.exactOptionalPropertyTypes ===
                false && inherited.includes("@vue/tsconfig/tsconfig.dom.json")
                ? ["exactOptionalPropertyTypes"]
                : []),
              ...(config.compilerOptions?.skipLibCheck === true &&
              config.compilerOptions.moduleResolution === "bundler"
                ? ["skipLibCheck"]
                : []),
            ];
            assert.deepStrictEqual(
              { relativePath, repeatedPolicyOptions },
              {
                relativePath,
                repeatedPolicyOptions: allowedOverrides,
              },
            );
          }
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      });
    });
  }
});
