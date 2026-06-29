import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src/cli.ts");

function template(args: string[]) {
  return execa("pnpm", ["exec", "tsx", cliPath, ...args], { cwd: repoRoot });
}

describe("declaration contracts", () => {
  it("lists the built-in preset catalog", async () => {
    const result = await template(["presets"]);

    expect(result.stdout).toContain("Built-in presets");
    expect(result.stdout).toContain("ts-lib");
    expect(result.stdout).toContain("TypeScript library");
    expect(result.stdout).toContain("vue-app");
    expect(result.stdout).toContain("Vue app");
    expect(result.stdout).toContain("(supported)");
  });

  it("prints published JSON Schemas for declarations", async () => {
    const presetSchema = JSON.parse(
      (await template(["schema", "preset"])).stdout
    ) as { title: string; type: string; required: string[] };
    const blueprintSchema = JSON.parse(
      (await template(["schema", "blueprint"])).stdout
    ) as { title: string; type: string; required: string[] };

    expect(presetSchema).toMatchObject({
      title: "Project Kit Preset File",
      type: "object"
    });
    expect(presetSchema.required).toContain("name");
    expect(presetSchema.required).toContain("features");

    expect(blueprintSchema).toMatchObject({
      title: "Project Kit Blueprint",
      type: "object"
    });
    expect(blueprintSchema.required).toContain("preset");
    expect(blueprintSchema.required).toContain("packageManager");
  });

  it("validates a JSON preset file through the CLI", async () => {
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
          supportedProjectKinds: ["single-package"],
          features: ["strict-typescript", "root-check"]
        },
        null,
        2
      )}\n`
    );

    const result = await template(["preset", "validate", presetPath]);

    expect(result.stdout).toContain("Preset file is valid");
    expect(result.stdout).toContain("custom-lib");
  });

  it("rejects future built-in preset references in preset files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-future-preset-"));
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
          supportedProjectKinds: ["single-package"],
          features: []
        },
        null,
        2
      )}\n`
    );

    await expect(
      template(["preset", "validate", presetPath])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Preset node-cli is not supported for generation in this version"
      )
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
          projectKind: "single-package",
          features: ["strict-typescript", "root-check"],
          packages: [{ name: "demo-lib", path: "." }]
        },
        null,
        2
      )}\n`
    );

    const result = await template(["blueprint", "validate", blueprintPath]);

    expect(result.stdout).toContain("Blueprint is valid");
    expect(result.stdout).toContain("ts-lib");
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
          description: "Missing required declaration fields."
        },
        null,
        2
      )}\n`
    );

    await expect(
      template(["preset", "validate", presetPath])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Preset file is invalid")
    });

    await expect(
      template(["preset", "validate", presetPath])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("$.schemaVersion")
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
            { name: "app", path: "packages/app" }
          ]
        },
        null,
        2
      )}\n`
    );

    await expect(
      template(["blueprint", "validate", blueprintPath])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("strict-typescript is not supported by preset ts-app")
    });
    await expect(
      template(["blueprint", "validate", blueprintPath])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("$.packages.name")
    });
  });

  it("rejects multiple distinct packages in a single-package blueprint", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-single-package-"));
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
          packages: [
            { name: "api", path: "packages/api" },
            { name: "web", path: "packages/web" }
          ]
        },
        null,
        2
      )}\n`
    );

    await expect(
      template(["blueprint", "validate", blueprintPath])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "single-package blueprints support exactly one package"
      )
    });
  });

  it("rejects future built-in presets in project blueprints", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-future-blueprint-"));
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
          packages: [{ name: "app", path: "." }]
        },
        null,
        2
      )}\n`
    );

    await expect(
      template(["blueprint", "validate", blueprintPath])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Preset ts-app is not supported for generation in this version"
      )
    });
  });

  it("accepts only JSON declaration files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-json-only-"));
    const presetPath = path.join(workspace, "preset.yaml");
    await writeFile(presetPath, "schemaVersion: 1\n");

    await expect(
      template(["preset", "validate", presetPath])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Declaration files must be JSON")
    });
  });
});
