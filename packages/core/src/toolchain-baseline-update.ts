export type ToolchainBaseline = {
  readonly nodeLtsMajor: string;
  readonly packageManagerPin: `pnpm@${string}`;
};

export type ToolchainPullRequestCandidate =
  | { readonly kind: "absent" }
  | { readonly kind: "open"; readonly pullRequestNumber: number };

export type ToolchainRemoteBranch =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly sha: string };

export type ToolchainUpdateCandidate = {
  readonly pullRequest: ToolchainPullRequestCandidate;
  readonly remoteBranch: ToolchainRemoteBranch;
};

export type ToolchainBaselineUpdatePlan =
  | { readonly kind: "no-drift" }
  | {
      readonly kind: "cleanup-stale";
      readonly pullRequestNumber?: number;
      readonly deleteBranch: true;
    }
  | {
      readonly kind: "update";
      readonly mode: "create";
      readonly desired: ToolchainBaseline;
    }
  | {
      readonly kind: "update";
      readonly mode: "replace";
      readonly pullRequestNumber: number;
      readonly desired: ToolchainBaseline;
    };

type PlanToolchainBaselineUpdateOptions = {
  readonly current: ToolchainBaseline & {
    readonly materialConsistent?: boolean;
  };
  readonly desired: ToolchainBaseline;
  readonly candidate: ToolchainUpdateCandidate;
};

export function planToolchainBaselineUpdate(
  options: PlanToolchainBaselineUpdateOptions,
): ToolchainBaselineUpdatePlan {
  const hasDrift =
    options.current.materialConsistent === false ||
    options.current.nodeLtsMajor !== options.desired.nodeLtsMajor ||
    options.current.packageManagerPin !== options.desired.packageManagerPin;

  if (!hasDrift) {
    return options.candidate.pullRequest.kind === "absent" &&
      options.candidate.remoteBranch.kind === "absent"
      ? { kind: "no-drift" }
      : {
          kind: "cleanup-stale",
          ...(options.candidate.pullRequest.kind === "open"
            ? {
                pullRequestNumber:
                  options.candidate.pullRequest.pullRequestNumber,
              }
            : {}),
          deleteBranch: true,
        };
  }

  return options.candidate.pullRequest.kind === "absent"
    ? { kind: "update", mode: "create", desired: options.desired }
    : {
        kind: "update",
        mode: "replace",
        pullRequestNumber: options.candidate.pullRequest.pullRequestNumber,
        desired: options.desired,
      };
}
