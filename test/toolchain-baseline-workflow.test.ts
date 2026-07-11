import { readFile } from "node:fs/promises";

import { parse } from "yaml";

describe("Toolchain Baseline scheduled workflow", () => {
  it("grants only the write capabilities needed to maintain one reviewed candidate", async () => {
    const workflow = parse(
      await readFile(
        ".github/workflows/toolchain-resolution-contract.yml",
        "utf8",
      ),
    ) as {
      permissions: Record<string, string>;
      concurrency: { group: string; "cancel-in-progress": boolean };
      jobs: {
        check: {
          steps: Array<{
            name?: string;
            run?: string;
            uses?: string;
            with?: Record<string, string>;
          }>;
        };
      };
    };

    expect(workflow.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    expect(workflow.concurrency).toEqual({
      group: "toolchain-baseline-update",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs.check.steps.map((step) => step.run)).toContain(
      "pnpm run update:toolchain",
    );
    const names = workflow.jobs.check.steps.map((step) => step.name);
    expect(names.indexOf("Resolve updater toolchain")).toBeLessThan(
      names.indexOf("Set up resolved Node.js"),
    );
    expect(names.indexOf("Set up resolved Node.js")).toBeLessThan(
      names.indexOf("Provision resolved pnpm"),
    );
    expect(names.indexOf("Provision resolved pnpm")).toBeLessThan(
      names.indexOf("Refresh Toolchain Baseline candidate"),
    );
    expect(
      workflow.jobs.check.steps.find(
        (step) => step.name === "Set up resolved Node.js",
      )?.with?.["node-version"],
    ).toContain("desired-toolchain.outputs.node-major");
    expect(JSON.stringify(workflow)).not.toContain("merge");
  });
});
