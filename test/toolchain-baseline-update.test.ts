import { planToolchainBaselineUpdate } from "@ykdz/template-core/toolchain-baseline-update";

const current = {
  nodeLtsMajor: "24",
  packageManagerPin: "pnpm@11.11.0" as const,
};
const absent = {
  pullRequest: { kind: "absent" as const },
  remoteBranch: { kind: "absent" as const },
};
const open = {
  pullRequest: { kind: "open" as const, pullRequestNumber: 41 },
  remoteBranch: { kind: "present" as const, sha: "abc123" },
};

describe("toolchain baseline update planning", () => {
  it("does nothing when the repository baseline is current and no candidate exists", () => {
    expect(
      planToolchainBaselineUpdate({
        current,
        desired: current,
        candidate: absent,
      }),
    ).toEqual({ kind: "no-drift" });
  });

  it("creates the sole review candidate when the baseline drifts", () => {
    expect(
      planToolchainBaselineUpdate({
        current,
        desired: { nodeLtsMajor: "26", packageManagerPin: "pnpm@12.1.0" },
        candidate: absent,
      }),
    ).toEqual({
      kind: "update",
      mode: "create",
      desired: { nodeLtsMajor: "26", packageManagerPin: "pnpm@12.1.0" },
    });
  });

  it("repairs baseline material that has diverged even when the visible pins match", () => {
    expect(
      planToolchainBaselineUpdate({
        current: { ...current, materialConsistent: false },
        desired: current,
        candidate: absent,
      }),
    ).toEqual({ kind: "update", mode: "create", desired: current });
  });

  it("replaces an existing candidate with drift resolved from the latest default branch", () => {
    expect(
      planToolchainBaselineUpdate({
        current,
        desired: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.12.0" },
        candidate: open,
      }),
    ).toEqual({
      kind: "update",
      mode: "replace",
      pullRequestNumber: 41,
      desired: { nodeLtsMajor: "24", packageManagerPin: "pnpm@11.12.0" },
    });
  });

  it("cleans up a stale review candidate when drift disappears", () => {
    expect(
      planToolchainBaselineUpdate({
        current,
        desired: current,
        candidate: open,
      }),
    ).toEqual({
      kind: "cleanup-stale",
      pullRequestNumber: 41,
      deleteBranch: true,
    });
  });

  it("deletes a stale remote automation branch even when no PR is open", () => {
    expect(
      planToolchainBaselineUpdate({
        current,
        desired: current,
        candidate: {
          pullRequest: { kind: "absent" },
          remoteBranch: { kind: "present", sha: "abc123" },
        },
      }),
    ).toEqual({ kind: "cleanup-stale", deleteBranch: true });
  });
});
