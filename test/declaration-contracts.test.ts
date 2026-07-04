import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findBuiltInPreset } from "@ykdz/template-builtin-source";
import { execa } from "execa";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(repoRoot, "packages", "cli", "src", "cli.ts");

function template(args: string[]) {
  return execa("pnpm", ["exec", "tsx", cliPath, ...args], { cwd: repoRoot });
}

function validPresetSourceManifest(): any {
  return {
    schemaVersion: 1,
    name: "custom-source",
    sharedResources: [{ id: "shared-oxc-node", path: "shared/oxc/node" }],
    presets: [
      {
        name: "custom-lib",
        title: "Custom library",
        description: "A custom strict TypeScript library preset.",
        generation: "supported",
        supportedPackageManagers: ["pnpm"],
        supportedProjectKinds: ["multi-package"],
        packageAdditionSupport: "unsupported",
        features: ["strict-typescript", "root-check"],
      },
    ],
  };
}

describe("declaration contracts", () => {
  it("lists the built-in preset catalog", async () => {
    const result = await template(["presets"]);

    expect(result.stdout).toContain("Built-in presets");
    expect(result.stdout).toContain("ts-lib");
    expect(result.stdout).toContain("TypeScript library");
    expect(result.stdout).toContain("vue-app");
    expect(result.stdout).toContain("Vue app");
    expect(result.stdout).toContain("vue-hono-app");
    expect(result.stdout).toContain("Vue Hono app");
    expect(result.stdout).toContain("(supported)");
  });

  it("prints published JSON Schemas for declarations", async () => {
    const presetSchema = JSON.parse(
      (await template(["schema", "preset"])).stdout,
    ) as {
      title: string;
      type: string;
      required: string[];
      properties: {
        supportedProjectKinds: { items: { enum: string[] } };
      };
    };
    const blueprintSchema = JSON.parse(
      (await template(["schema", "blueprint"])).stdout,
    ) as {
      title: string;
      type: string;
      required: string[];
      properties: { projectKind: { enum: string[] } };
    };

    expect(presetSchema).toMatchObject({
      title: "Project Kit Preset File",
      type: "object",
    });
    expect(presetSchema.required).toContain("name");
    expect(presetSchema.required).toContain("features");
    expect(presetSchema.properties.supportedProjectKinds.items.enum).toEqual([
      "multi-package",
    ]);

    expect(blueprintSchema).toMatchObject({
      title: "Project Kit Blueprint",
      type: "object",
    });
    expect(blueprintSchema.required).toContain("preset");
    expect(blueprintSchema.required).not.toContain("packageManager");
    expect(blueprintSchema.properties.projectKind.enum).toEqual([
      "multi-package",
    ]);
  });

  it("prints the Preset Source Manifest JSON Schema", async () => {
    const presetSourceSchema = JSON.parse(
      (await template(["schema", "preset-source"])).stdout,
    ) as {
      title: string;
      type: string;
      required: string[];
      properties: {
        fixtureMatrix: {
          required: string[];
          properties: {
            environmentPreparation: { items: { enum: string[] } };
            checkRequirements: { items: { enum: string[] } };
          };
        };
        presets: {
          items: {
            required: string[];
            properties: {
              packageAdditionSupport: { enum: string[] };
            };
          };
        };
      };
    };

    expect(presetSourceSchema).toMatchObject({
      title: "Preset Source Manifest",
      type: "object",
    });
    expect(presetSourceSchema.required).toContain("presets");
    expect(presetSourceSchema.properties.fixtureMatrix.required).toEqual([
      "initSupport",
      "packageAdditionSupport",
      "supportedCombinations",
      "semanticSkips",
      "checkRequirements",
      "environmentPreparation",
    ]);
    expect(
      presetSourceSchema.properties.fixtureMatrix.properties.checkRequirements
        .items.enum,
    ).toEqual(["machine-verifiable-next-steps", "root-check-ci"]);
    expect(
      presetSourceSchema.properties.fixtureMatrix.properties
        .environmentPreparation.items.enum,
    ).toEqual(["playwright-browser-assets"]);
    expect(presetSourceSchema.properties.presets.items.required).toEqual(
      expect.arrayContaining([
        "name",
        "title",
        "description",
        "generation",
        "supportedPackageManagers",
        "supportedProjectKinds",
        "packageAdditionSupport",
        "features",
      ]),
    );
    expect(
      presetSourceSchema.properties.presets.items.properties
        .packageAdditionSupport.enum,
    ).toEqual(["supported", "unsupported"]);

    const capabilitySchemas = (presetSourceSchema as any).properties.presets
      .items.properties.projection.properties.capabilities.items.oneOf;
    const nodeWorkspaceSchema = capabilitySchemas.find(
      (schema: any) =>
        schema.properties.kind.const === "workspace-node-packages",
    );

    expect(nodeWorkspaceSchema).toMatchObject({
      additionalProperties: false,
      required: ["kind", "workspacePackageGlob", "packages"],
      properties: {
        workspacePackageGlob: { const: "apps/*" },
        packages: {
          minItems: 1,
          items: {
            additionalProperties: false,
            required: ["kind", "path", "sourceFiles"],
            properties: {
              kind: { enum: ["hono-api", "vue-app"] },
              path: { enum: ["apps/api", "apps/web"] },
              sourceFiles: { minItems: 1 },
            },
          },
        },
        packageLinks: {
          items: {
            additionalProperties: false,
            required: ["consumerPackagePath", "providerPackagePath"],
            properties: {
              consumerPackagePath: { const: "apps/web" },
              providerPackagePath: { const: "apps/api" },
            },
          },
        },
      },
    });
  });

  it("validates Preset Source Manifest references relative to the manifest file through the CLI", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "preset-source-cli-"));
    const manifestPath = path.join(workspace, "preset-source.json");
    const manifest = validPresetSourceManifest();
    manifest.presets[0].source = {
      files: ["custom-lib/src/index.ts"],
    };

    await mkdir(path.join(workspace, "shared/oxc/node"), { recursive: true });
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    await expect(
      template(["preset-source", "validate", manifestPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Preset custom-lib source file does not exist: custom-lib/src/index.ts",
      ),
    });
  });

  it("rejects Preset Source Manifest path escapes through the CLI", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "preset-source-cli-"));
    const manifestPath = path.join(workspace, "preset-source.json");
    const manifest = validPresetSourceManifest();
    manifest.sharedResources[0].path = "../shared/oxc/node";

    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    await expect(
      template(["preset-source", "validate", manifestPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Preset Source path escapes its source boundary: ../shared/oxc/node",
      ),
    });
  });

  it("advertises pnpm support for the Rust preset task layer", () => {
    expect(findBuiltInPreset("rust-bin")?.supportedPackageManagers).toEqual([
      "pnpm",
    ]);
  });

  it("validates a workspace monorepo JSON preset file through the CLI", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-preset-"));
    const presetPath = path.join(workspace, "preset.json");
    await writeFile(
      presetPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: "custom-lib",
          title: "Custom library",
          description: "A custom strict TypeScript library preset.",
          supportedPackageManagers: ["pnpm"],
          supportedProjectKinds: ["multi-package"],
          features: ["strict-typescript", "root-check"],
        },
        null,
        2,
      )}\n`,
    );

    const result = await template(["preset", "validate", presetPath]);

    expect(result.stdout).toContain("Preset file is valid");
    expect(result.stdout).toContain("custom-lib");
  });

  it("validates a Preset Source Manifest through the CLI", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-source-"),
    );
    const manifestPath = path.join(workspace, "preset-source.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: "custom-source",
          presets: [
            {
              name: "custom-lib",
              title: "Custom library",
              description: "A custom strict TypeScript library preset.",
              generation: "supported",
              supportedPackageManagers: ["pnpm"],
              supportedProjectKinds: ["multi-package"],
              packageAdditionSupport: "unsupported",
              features: ["strict-typescript", "root-check"],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const result = await template(["preset-source", "validate", manifestPath]);

    expect(result.stdout).toContain("Preset Source Manifest is valid");
    expect(result.stdout).toContain("custom-source");
    expect(result.stdout).toContain("custom-lib");
  });

  it("rejects duplicate Preset Source Manifest array values through the CLI", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-source-duplicates-"),
    );
    const manifestPath = path.join(workspace, "preset-source.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: "custom-source",
          presets: [
            {
              name: "custom-lib",
              title: "Custom library",
              description: "A custom strict TypeScript library preset.",
              generation: "supported",
              supportedPackageManagers: ["pnpm", "pnpm"],
              supportedProjectKinds: ["multi-package", "multi-package"],
              packageAdditionSupport: "unsupported",
              features: ["strict-typescript", "strict-typescript"],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      template(["preset-source", "validate", manifestPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "$.presets[0].supportedPackageManagers: Duplicate value: pnpm",
      ),
    });
    await expect(
      template(["preset-source", "validate", manifestPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "$.presets[0].supportedProjectKinds: Duplicate value: multi-package",
      ),
    });
    await expect(
      template(["preset-source", "validate", manifestPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "$.presets[0].features: Duplicate value: strict-typescript",
      ),
    });
  });

  it("validates the built-in Preset Source Manifest through the CLI", async () => {
    const result = await template([
      "preset-source",
      "validate",
      "packages/builtin-source/templates/preset-source.json",
    ]);

    expect(result.stdout).toContain("Preset Source Manifest is valid");
    expect(result.stdout).toContain("built-in");
    expect(result.stdout).toContain("ts-lib");
    expect(result.stdout).toContain("vue-hono-app");
    expect(result.stdout).toContain("rust-bin");
  });

  it("rejects supported built-in Preset Source Manifests without Projection Declarations through the CLI", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-source-bridge-"),
    );
    const manifestPath = path.join(workspace, "preset-source.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: "built-in",
          presets: [
            {
              name: "missing-supported",
              title: "Missing supported preset",
              description: "A supported built-in preset with no projection.",
              generation: "supported",
              supportedPackageManagers: ["pnpm"],
              supportedProjectKinds: ["multi-package"],
              packageAdditionSupport: "unsupported",
              features: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      template(["preset-source", "validate", manifestPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Supported Preset missing-supported must declare a Projection Declaration",
      ),
    });
  });

  it("rejects preset files that claim single-package support in V1", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-single-package-preset-"),
    );
    const presetPath = path.join(workspace, "preset.json");
    await writeFile(
      presetPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: "custom-lib",
          title: "Custom library",
          description: "A custom strict TypeScript library preset.",
          supportedPackageManagers: ["pnpm"],
          supportedProjectKinds: ["single-package"],
          features: ["strict-typescript", "root-check"],
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      template(["preset", "validate", presetPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "single-package Project Shape is unsupported in V1",
      ),
    });
  });

  it("rejects future built-in preset references in preset files", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-future-preset-"),
    );
    const presetPath = path.join(workspace, "preset.json");
    await writeFile(
      presetPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: "node-cli",
          title: "Node CLI",
          description: "A future built-in preset reference.",
          supportedPackageManagers: ["pnpm"],
          supportedProjectKinds: ["multi-package"],
          features: [],
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      template(["preset", "validate", presetPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Preset node-cli is not supported for generation in this version",
      ),
    });
  });

  it("rejects Post Commands in user Preset Files", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-preset-post-commands-"),
    );
    const presetPath = path.join(workspace, "preset.json");
    await writeFile(
      presetPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: "custom-lib",
          title: "Custom library",
          description: "A custom strict TypeScript library preset.",
          supportedPackageManagers: ["pnpm"],
          supportedProjectKinds: ["single-package"],
          features: ["strict-typescript", "root-check"],
          postCommands: [
            {
              command: "pnpm",
              args: ["install"],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      template(["preset", "validate", presetPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Preset file is invalid"),
    });
    await expect(
      template(["preset", "validate", presetPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("$.postCommands"),
    });
  });

  it("validates a project blueprint against the built-in preset catalog", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-blueprint-"));
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          preset: "ts-lib",
          packageManager: "pnpm",
          projectKind: "multi-package",
          features: ["strict-typescript", "root-check"],
          packages: [{ name: "@demo-lib/demo-lib", path: "packages/demo-lib" }],
        },
        null,
        2,
      )}\n`,
    );

    const result = await template(["blueprint", "validate", blueprintPath]);

    expect(result.stdout).toContain("Blueprint is valid");
    expect(result.stdout).toContain("ts-lib");
  });

  it("validates stable Package Definition intent in project blueprints", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-package-definition-"),
    );
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          preset: "ts-lib",
          packageManager: "pnpm",
          projectKind: "multi-package",
          features: ["strict-typescript", "root-check"],
          packages: [
            {
              name: "@demo-lib/demo-lib",
              path: "packages/demo-lib",
              role: "shared-library",
              sourcePreset: "ts-lib",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const result = await template(["blueprint", "validate", blueprintPath]);

    expect(result.stdout).toContain("Blueprint is valid");
    expect(result.stdout).toContain("ts-lib");
  });

  it("validates a multi-package vue-hono-app blueprint", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-fullstack-blueprint-"),
    );
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          preset: "vue-hono-app",
          packageManager: "pnpm",
          projectKind: "multi-package",
          features: ["strict-typescript", "root-check"],
          packages: [
            { name: "@demo/web", path: "apps/web" },
            { name: "@demo/api", path: "apps/api" },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const result = await template(["blueprint", "validate", blueprintPath]);

    expect(result.stdout).toContain("Blueprint is valid");
    expect(result.stdout).toContain("vue-hono-app");
  });

  it("reports schema validation failures with useful paths", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-invalid-"));
    const presetPath = path.join(workspace, "preset.json");
    await writeFile(
      presetPath,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          name: "",
          title: "Broken preset",
          description: "Missing required declaration fields.",
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      template(["preset", "validate", presetPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Preset file is invalid"),
    });

    await expect(
      template(["preset", "validate", presetPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("$.schemaVersion"),
    });
  });

  it("reports semantic blueprint failures before generation", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-semantic-"));
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          preset: "ts-app",
          packageManager: "pnpm",
          projectKind: "single-package",
          features: ["strict-typescript"],
          packages: [
            { name: "app", path: "packages/app" },
            { name: "app", path: "packages/app" },
          ],
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      template(["blueprint", "validate", blueprintPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "strict-typescript is not supported by preset ts-app",
      ),
    });
    await expect(
      template(["blueprint", "validate", blueprintPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("$.packages.name"),
    });
  });

  it("rejects single-package blueprints because V1 only supports workspace monorepos", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-single-package-"),
    );
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          preset: "ts-lib",
          packageManager: "pnpm",
          projectKind: "single-package",
          features: ["strict-typescript", "root-check"],
          packages: [{ name: "api", path: "packages/api" }],
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      template(["blueprint", "validate", blueprintPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "single-package Project Shape is unsupported in V1",
      ),
    });
  });

  it("rejects future built-in presets in project blueprints", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-future-blueprint-"),
    );
    const blueprintPath = path.join(workspace, "blueprint.json");
    await writeFile(
      blueprintPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          preset: "ts-app",
          packageManager: "pnpm",
          projectKind: "single-package",
          features: [],
          packages: [{ name: "app", path: "." }],
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      template(["blueprint", "validate", blueprintPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Preset ts-app is not supported for generation in this version",
      ),
    });
  });

  it("accepts only JSON declaration files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-json-only-"));
    const presetPath = path.join(workspace, "preset.yaml");
    await writeFile(presetPath, "schemaVersion: 1\n");

    await expect(
      template(["preset", "validate", presetPath]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Declaration files must be JSON"),
    });
  });
});
