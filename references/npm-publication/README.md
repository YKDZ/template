# npm 发布配置

本参考包提供 Changesets 原生依赖、配置和 GitHub Actions 工作流。启用发布能力后，生成项目直接使用 Changesets，不复制发布工具项目或辅助脚本。

目标包以 `private: false` 参与发布，版本与包间依赖使用原生 `package.json` 管理。可以手工修改版本，也可以按需使用 `pnpm exec changeset` 和 `pnpm exec changeset version`；不要求每次提交添加 changeset，不自动创建版本 PR。

`pnpm publication:pack` 把未发布版本打包到 `.changeset/packed`；`pnpm publication:publish` 发布同一目录中的制品。打包前由 Turbo 根据工作区依赖顺序统一构建；包内无需发布生命周期脚本。包选择、依赖顺序、已发布版本跳过和发布错误处理遵循 Changesets 的约定。

GitHub Actions 通过 `release.yml` 手动触发。检查与打包在只读作业中完成，独立发布作业使用 npm Trusted Publishing 上传官方打包 Action 传递的制品；存在当前版本 CHANGELOG 时，按 Changesets 约定创建 GitHub Release。每个包需在 npm 配置实际 GitHub 仓库、工作流 `release.yml` 和环境 `npm`；首次发布、权限与可信发布者配置使用 npm 官方工具完成。

参考 [Changesets 自动化文档](https://changesets.dev/guide/automating)和 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)。
