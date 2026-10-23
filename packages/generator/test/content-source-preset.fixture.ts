export const preset = {
  kind: "preset" as const,
  metadata: {
    alias: "typed-preset",
    title: "类型化预设",
    description: "用于验证预设定义类型保真的测试内容。",
  },
  operations: ["init"] as const,
  nodes: {
    library: {
      reference: { alias: "typed-reference", instance: "independent" as const },
      creationInput: { init: { seed: "preset" } },
    },
  },
  externalPresetField: 42 as const,
};
