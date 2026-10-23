import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  resolveTemplateSource,
  type TemplateSourceHandle,
} from "@ykdz/template-core/template-source";

export type DevelopmentContainerToolLayerBuildArgument = {
  readonly name: string;
  readonly value: string;
};

export type DevelopmentContainerToolLayerMount = {
  readonly identity: string;
  readonly type: "bind" | "volume";
  readonly source: string;
  readonly target: string;
};

export type DevelopmentContainerToolLayerProbe = {
  readonly identity: string;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly failureMessage?: string | undefined;
};

export type DevelopmentContainerToolLayer = {
  readonly identity: string;
  readonly dockerfile: {
    readonly source: TemplateSourceHandle;
    readonly from: string;
  };
  readonly requires?: readonly string[] | undefined;
  readonly buildArguments?:
    | readonly DevelopmentContainerToolLayerBuildArgument[]
    | undefined;
  readonly mounts?: readonly DevelopmentContainerToolLayerMount[] | undefined;
  readonly probes?: readonly DevelopmentContainerToolLayerProbe[] | undefined;
};

export type PlannedDevelopmentContainerToolLayer =
  DevelopmentContainerToolLayer & {
    readonly kind: "base" | "optional";
  };

export type DevelopmentContainerToolLayerPlan = {
  readonly layers: readonly PlannedDevelopmentContainerToolLayer[];
  readonly buildArguments: readonly DevelopmentContainerToolLayerBuildArgument[];
  readonly mounts: readonly DevelopmentContainerToolLayerMount[];
  readonly probes: readonly DevelopmentContainerToolLayerProbe[];
};

type LogicalDockerfileInstruction = {
  readonly name: string;
  readonly arguments: string;
};

type DevelopmentContainerDockerfileFragment = {
  readonly identity: string;
  readonly kind: "base" | "optional";
  readonly from: string;
  readonly text: string;
};

function hasContinuation(line: string, escapeCharacter: string): boolean {
  const trimmed = line.trimEnd();
  let escapeCount = 0;

  for (
    let index = trimmed.length - 1;
    index >= 0 && trimmed[index] === escapeCharacter;
    index -= 1
  ) {
    escapeCount += 1;
  }

  return escapeCount % 2 === 1;
}

function parseLogicalDockerfileInstructions(
  text: string,
  sourceFile: string,
): readonly LogicalDockerfileInstruction[] {
  const instructions: LogicalDockerfileInstruction[] = [];
  let escapeCharacter = "\\";
  let logicalLine = "";

  for (const physicalLine of text.split(/\r?\n/u)) {
    const trimmed = physicalLine.trim();

    if (logicalLine.length === 0 && trimmed.startsWith("#")) {
      const escapeDirective = trimmed.match(/^#\s*escape\s*=\s*([\\`])\s*$/iu);
      if (escapeDirective?.[1] !== undefined) {
        escapeCharacter = escapeDirective[1];
      }
      continue;
    }

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const continuation = hasContinuation(physicalLine, escapeCharacter);
    const physicalContent = continuation
      ? physicalLine.trimEnd().slice(0, -1)
      : physicalLine;
    logicalLine += physicalContent.trimStart();

    if (continuation) {
      continue;
    }

    const match = logicalLine.match(/^([A-Za-z]+)(?:[ \t]+(.*))?$/u);
    if (match?.[1] === undefined) {
      throw new Error(
        `Development Container Dockerfile fragment ${sourceFile} contains an invalid logical instruction: ${logicalLine}`,
      );
    }

    instructions.push({
      name: match[1].toUpperCase(),
      arguments: match[2] ?? "",
    });
    logicalLine = "";
  }

  if (logicalLine.length > 0) {
    throw new Error(
      `Development Container Dockerfile fragment ${sourceFile} ends with an unterminated line continuation.`,
    );
  }

  return instructions;
}

function instructionNames(
  instructions: readonly LogicalDockerfileInstruction[],
  instruction: string,
): Set<string> {
  return new Set(
    instructions
      .filter(({ name }) => name === instruction)
      .map(({ arguments: value }) => value.trim().split(/[\s=]/u)[0]!)
      .filter((name) => name.length > 0),
  );
}

function dockerfileWords(value: string): readonly string[] {
  const words: string[] = [];
  let word = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        word += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (word.length > 0) {
        words.push(word);
        word = "";
      }
      continue;
    }
    word += character;
  }

  if (escaped) {
    word += "\\";
  }
  if (word.length > 0) {
    words.push(word);
  }
  return words;
}

function environmentNames(
  instructions: readonly LogicalDockerfileInstruction[],
): Set<string> {
  const names = new Set<string>();

  for (const instruction of instructions) {
    if (instruction.name !== "ENV") {
      continue;
    }
    const words = dockerfileWords(instruction.arguments);
    const first = words[0];
    if (first === undefined) {
      continue;
    }
    if (!first.includes("=")) {
      names.add(first);
      continue;
    }
    for (const assignment of words) {
      const separator = assignment.indexOf("=");
      if (separator > 0) {
        names.add(assignment.slice(0, separator));
      }
    }
  }

  return names;
}

function validateDockerfileFragment(
  fragment: DevelopmentContainerDockerfileFragment,
): readonly LogicalDockerfileInstruction[] {
  if (!fragment.from.endsWith(".Dockerfile")) {
    throw new Error(
      `Development Container Tool Layer ${fragment.identity} must reference checked .Dockerfile template source; received ${fragment.from}.`,
    );
  }

  const instructions = parseLogicalDockerfileInstructions(
    fragment.text,
    fragment.from,
  );
  const allowedInstructions =
    fragment.kind === "base"
      ? new Set(["ARG", "ENV", "FROM", "RUN", "SHELL"])
      : new Set(["ARG", "ENV", "RUN"]);

  for (const instruction of instructions) {
    if (!allowedInstructions.has(instruction.name)) {
      const role = fragment.kind === "base" ? "base" : "optional";
      const allowed =
        fragment.kind === "base"
          ? "ARG, ENV, FROM, RUN, and SHELL"
          : "ARG, ENV, and RUN";
      throw new Error(
        `Development Container Tool Layer ${fragment.identity} ${role} fragment ${fragment.from} must not use Dockerfile instruction ${instruction.name}; allowed instructions are ${allowed}.`,
      );
    }
  }

  if (fragment.kind === "base") {
    const fromCount = instructions.filter(
      (instruction) => instruction.name === "FROM",
    ).length;
    if (fromCount !== 1) {
      throw new Error(
        `Development Container Tool Layer ${fragment.identity} base fragment ${fragment.from} must contain exactly one FROM instruction; found ${fromCount}.`,
      );
    }
  }

  return instructions;
}

export function validateDevelopmentContainerDockerfileFragments(options: {
  readonly baseFragment: Omit<DevelopmentContainerDockerfileFragment, "kind">;
  readonly fragments?: readonly Omit<
    DevelopmentContainerDockerfileFragment,
    "kind"
  >[];
}): void {
  validateDockerfileFragment({ ...options.baseFragment, kind: "base" });
  for (const fragment of options.fragments ?? []) {
    validateDockerfileFragment({ ...fragment, kind: "optional" });
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertDockerfileTemplateSource(
  layer: DevelopmentContainerToolLayer,
): void {
  if (!layer.dockerfile.from.endsWith(".Dockerfile")) {
    throw new Error(
      `Development Container Tool Layer ${layer.identity} must reference checked .Dockerfile template source; received ${layer.dockerfile.from}.`,
    );
  }
}

function normalizeLayer(
  layer: DevelopmentContainerToolLayer,
): DevelopmentContainerToolLayer {
  assertDockerfileTemplateSource(layer);
  const buildArgumentNames = new Set<string>();
  for (const argument of layer.buildArguments ?? []) {
    if (buildArgumentNames.has(argument.name)) {
      throw new Error(
        `Development Container Tool Layer ${layer.identity} declares build argument ${argument.name} more than once.`,
      );
    }
    buildArgumentNames.add(argument.name);
  }
  return {
    ...layer,
    requires: [...new Set(layer.requires ?? [])].toSorted(compareText),
    buildArguments: [...(layer.buildArguments ?? [])].toSorted(
      (left, right) =>
        compareText(left.name, right.name) ||
        compareText(left.value, right.value),
    ),
    mounts: [...(layer.mounts ?? [])]
      .map((mount) => ({
        ...mount,
        target: path.posix.normalize(mount.target),
      }))
      .toSorted(
        (left, right) =>
          compareText(left.identity, right.identity) ||
          compareText(left.target, right.target),
      ),
    probes: [...(layer.probes ?? [])]
      .map((probe) => ({
        ...probe,
        args: [...(probe.args ?? [])],
      }))
      .toSorted(
        (left, right) =>
          compareText(left.identity, right.identity) ||
          compareText(left.command, right.command) ||
          compareText(JSON.stringify(left.args), JSON.stringify(right.args)),
      ),
  };
}

function layerFingerprint(
  layer: DevelopmentContainerToolLayer,
  kind: "base" | "optional",
): string {
  return JSON.stringify({
    kind,
    identity: layer.identity,
    dockerfile: resolveTemplateSource(
      layer.dockerfile.source,
      layer.dockerfile.from,
    ),
    requires: layer.requires,
    buildArguments: layer.buildArguments,
    mounts: layer.mounts,
    probes: layer.probes,
  });
}

function findDependencyCycle(
  layers: readonly DevelopmentContainerToolLayer[],
): readonly string[] | undefined {
  const byIdentity = new Map(layers.map((layer) => [layer.identity, layer]));
  const complete = new Set<string>();
  const active: string[] = [];
  const activeSet = new Set<string>();

  const visit = (identity: string): readonly string[] | undefined => {
    if (activeSet.has(identity)) {
      return active.slice(active.indexOf(identity)).toSorted(compareText);
    }
    if (complete.has(identity)) {
      return undefined;
    }

    active.push(identity);
    activeSet.add(identity);
    const layer = byIdentity.get(identity);
    for (const dependency of layer?.requires ?? []) {
      if (!byIdentity.has(dependency)) {
        continue;
      }
      const cycle = visit(dependency);
      if (cycle !== undefined) {
        return cycle;
      }
    }
    active.pop();
    activeSet.delete(identity);
    complete.add(identity);
    return undefined;
  };

  for (const identity of [...byIdentity.keys()].toSorted(compareText)) {
    const cycle = visit(identity);
    if (cycle !== undefined) {
      return cycle;
    }
  }

  return undefined;
}

function orderLayers(
  baseLayer: DevelopmentContainerToolLayer,
  optionalLayers: readonly DevelopmentContainerToolLayer[],
): PlannedDevelopmentContainerToolLayer[] {
  const normalizedBase = normalizeLayer(baseLayer);
  if ((normalizedBase.requires?.length ?? 0) > 0) {
    throw new Error(
      `Development Container Tool Layer ${normalizedBase.identity} is the base foundation and must not require other layers.`,
    );
  }
  const base: PlannedDevelopmentContainerToolLayer = {
    ...normalizedBase,
    kind: "base",
  };
  const identities = new Map([[base.identity, layerFingerprint(base, "base")]]);
  const uniqueOptionalLayers: DevelopmentContainerToolLayer[] = [];

  for (const layer of optionalLayers) {
    const normalized = normalizeLayer(layer);
    const fingerprint = layerFingerprint(normalized, "optional");
    const previous = identities.get(normalized.identity);
    if (previous === fingerprint) {
      continue;
    }
    if (previous !== undefined) {
      throw new Error(
        `Development Container Tool Layer identity ${normalized.identity} has conflicting descriptors.`,
      );
    }
    identities.set(normalized.identity, fingerprint);
    uniqueOptionalLayers.push(normalized);
  }

  for (const layer of uniqueOptionalLayers) {
    for (const requiredIdentity of layer.requires ?? []) {
      if (!identities.has(requiredIdentity)) {
        throw new Error(
          `Development Container Tool Layer ${layer.identity} requires missing layer ${requiredIdentity}.`,
        );
      }
    }
  }

  const cycle = findDependencyCycle(uniqueOptionalLayers);
  if (cycle !== undefined) {
    throw new Error(
      `Development Container Tool Layer dependency cycle involves: ${cycle.join(", ")}.`,
    );
  }

  const remaining = uniqueOptionalLayers
    .map((layer): PlannedDevelopmentContainerToolLayer => ({
      ...layer,
      kind: "optional",
    }))
    .toSorted((left, right) => compareText(left.identity, right.identity));
  const ordered = [base];
  const resolved = new Set([base.identity]);

  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((layer) =>
      (layer.requires ?? []).every((identity) => resolved.has(identity)),
    );
    if (readyIndex === -1) {
      throw new Error(
        "Development Container Tool Layer dependencies cannot be resolved.",
      );
    }

    const [next] = remaining.splice(readyIndex, 1);
    if (next === undefined) {
      throw new Error(
        "Development Container Tool Layer dependency resolution failed.",
      );
    }
    ordered.push(next);
    resolved.add(next.identity);
  }

  return ordered;
}

function completeDevelopmentContainerToolLayerPlan(
  layers: readonly PlannedDevelopmentContainerToolLayer[],
  fragmentTexts: readonly string[],
): DevelopmentContainerToolLayerPlan {
  const buildArgumentOwners = new Map<string, string>();
  const environmentOwners = new Map<string, string>();
  const mountIdentityOwners = new Map<string, string>();
  const mountTargetOwners = new Map<string, string>();

  for (const [index, layer] of layers.entries()) {
    for (const mount of layer.mounts ?? []) {
      const previousIdentityOwner = mountIdentityOwners.get(mount.identity);
      if (previousIdentityOwner !== undefined) {
        throw new Error(
          `Development Container Tool Layer mount identity ${mount.identity} is declared by both ${previousIdentityOwner} and ${layer.identity}.`,
        );
      }
      const previousTargetOwner = mountTargetOwners.get(mount.target);
      if (previousTargetOwner !== undefined) {
        throw new Error(
          `Development Container Tool Layer mount target ${mount.target} is declared by both ${previousTargetOwner} and ${layer.identity}.`,
        );
      }
      mountIdentityOwners.set(mount.identity, layer.identity);
      mountTargetOwners.set(mount.target, layer.identity);
    }

    const instructions = validateDockerfileFragment({
      identity: layer.identity,
      kind: layer.kind,
      from: layer.dockerfile.from,
      text: fragmentTexts[index]!,
    });

    const declaredArguments = instructionNames(instructions, "ARG");
    for (const name of declaredArguments) {
      const previousOwner = buildArgumentOwners.get(name);
      if (previousOwner !== undefined) {
        throw new Error(
          `Development Container Tool Layer build argument ${name} is declared by both ${previousOwner} and ${layer.identity}.`,
        );
      }
      buildArgumentOwners.set(name, layer.identity);
    }
    for (const name of environmentNames(instructions)) {
      const previousOwner = environmentOwners.get(name);
      if (previousOwner !== undefined) {
        throw new Error(
          `Development Container Tool Layer environment ${name} is declared by both ${previousOwner} and ${layer.identity}.`,
        );
      }
      environmentOwners.set(name, layer.identity);
    }

    for (const argument of layer.buildArguments ?? []) {
      if (!declaredArguments.has(argument.name)) {
        throw new Error(
          `Development Container Tool Layer ${layer.identity} supplies build argument ${argument.name}, but ${layer.dockerfile.from} does not declare it with ARG.`,
        );
      }
    }
  }

  return {
    layers,
    buildArguments: layers.flatMap((layer) => layer.buildArguments ?? []),
    mounts: layers.flatMap((layer) => layer.mounts ?? []),
    probes: layers.flatMap((layer) => layer.probes ?? []),
  };
}

/** 将所属环境准备的 Dockerfile 文本交给纯层规划。 */
export function planDevelopmentContainerToolLayersFromTexts(options: {
  readonly baseLayer: DevelopmentContainerToolLayer;
  readonly layers?: readonly DevelopmentContainerToolLayer[] | undefined;
  readonly fragmentTexts: Readonly<Record<string, string>>;
}): DevelopmentContainerToolLayerPlan {
  const layers = orderLayers(options.baseLayer, options.layers ?? []);
  const fragmentTexts = layers.map((layer) => {
    const text = options.fragmentTexts[layer.dockerfile.from];
    if (text === undefined) {
      throw new Error(
        `Development Container Tool Layer ${layer.identity} 缺少所属准备文本 ${layer.dockerfile.from}.`,
      );
    }
    return text;
  });
  return completeDevelopmentContainerToolLayerPlan(layers, fragmentTexts);
}

/** 只验证并组合已准备文本，不读取模板资源。 */
export function developmentContainerDockerfileFromText(options: {
  readonly layers: readonly PlannedDevelopmentContainerToolLayer[];
  readonly fragmentTexts: Readonly<Record<string, string>>;
}): string {
  const [baseLayer, ...optionalLayers] = options.layers;
  if (baseLayer?.kind !== "base") {
    throw new Error("Development Container Dockerfile requires a base layer.");
  }
  if (optionalLayers.some((layer) => layer.kind !== "optional")) {
    throw new Error(
      "Development Container Dockerfile optional layers must follow the base layer.",
    );
  }
  const fragments = options.layers.map((layer) => {
    const text = options.fragmentTexts[layer.dockerfile.from];
    if (text === undefined) {
      throw new Error(
        `Development Container Tool Layer ${layer.identity} 缺少所属准备文本 ${layer.dockerfile.from}.`,
      );
    }
    return {
      identity: layer.dockerfile.from,
      from: layer.dockerfile.from,
      text,
    };
  });
  const [baseFragment, ...optionalFragments] = fragments;
  if (baseFragment === undefined) {
    throw new Error("Development Container Dockerfile requires a base layer.");
  }
  validateDevelopmentContainerDockerfileFragments({
    baseFragment,
    fragments: optionalFragments,
  });
  return fragments.map(({ text }) => text.trimEnd()).join("\n\n") + "\n";
}

/** 所属资源 owner 在准备阶段读取所选层文本，planner 只消费该快照。 */
export async function prepareDevelopmentContainerToolLayerTexts(options: {
  readonly baseLayer: DevelopmentContainerToolLayer;
  readonly layers?: readonly DevelopmentContainerToolLayer[] | undefined;
}): Promise<Readonly<Record<string, string>>> {
  const layers = orderLayers(options.baseLayer, options.layers ?? []);
  const entries = await Promise.all(
    layers.map(async (layer) => {
      try {
        return [
          layer.dockerfile.from,
          await readFile(
            resolveTemplateSource(
              layer.dockerfile.source,
              layer.dockerfile.from,
            ),
            "utf8",
          ),
        ] as const;
      } catch (cause) {
        throw new Error(
          `Development Container Tool Layer ${layer.identity} prepare 阶段无法读取 ${layer.dockerfile.from}.`,
          { cause },
        );
      }
    }),
  );
  return Object.fromEntries(entries);
}
