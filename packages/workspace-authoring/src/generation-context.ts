/** 工具链事实解析后提供的稳定工作区输入。 */
export type GenerationContext = {
  readonly targetDir: string;
  readonly repositoryName: string;
  readonly defaultPackageScope: string;
  readonly foundationPackages: {
    readonly typescriptConfiguration: {
      readonly name: string;
    };
  };
  readonly toolchain: {
    readonly nodeLtsMajor: string;
    readonly packageManagerPin: string;
    /** 精确三段 Node 版本；不可由大版本伪造，也不是回退值。 */
    readonly nodeVersion?: string;
    /** 已知 Rust channel；不是版本回退值，也不进入持久生成记录。 */
    readonly rustVersion?: string;
  };
};
