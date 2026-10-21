# 共享 npm 发布

本包为已显式启用发布能力的工作区包提供唯一的准备、整批本地验收、npm 发布与 GitHub Release 实现。常规 Actions 发布从默认分支手动触发，目标选择由 pnpm 原生 `--filter` 处理；命令与具体状态见生成根及作者根的 `publication:artifact`、发布 workflow。

本地首次发布由 `publication:setup` 显式取得并运行一次性向导。首次使用时传入一个或多个 `--filter`；不带选择器运行只会取得向导并显示用法。向导通过 `publication:artifact` 为所选目标准备、安装并验收原始 tgz。确认后依次调用 `publication:remote:npm` 和 `publication:remote:release`：前者按 pnpm 原生依赖顺序处理整批目标，后者只为已就绪目标创建 Release。npm 阶段报告部分失败时，向导仍运行 Release 阶段，让独立就绪目标继续；整体失败时保留 `.verified-packed-publication/first-release` 中的 accepted 清单、回执和 tgz。确认远端事实后可不带选择器重新运行向导续办原件。不要在版本可见性不确定时重新打包或重发。

发布前应检查目标包的 manifest 版本、当前版本 CHANGELOG 正文和默认分支提交。向导要求当前提交已推送、工作区干净，并在全部原件验收通过后才展示目标、版本和 SHA-512 供确认。它不会改源码或文档，也不会自动创建分支、commit、push 或 PR。npm 与 GitHub Release 共用同一 accepted 原件；远端失败时保留原件并按提示续办，不自动改写已存在的版本、tag 或 Release。

## 配置 Trusted Publisher

在首个真实后续版本准备发布时，按实际锁定的 npm 原生命令帮助确认本机 `npm trust github --help`，然后使用 npm 自带的 GitHub 信任配置，例如：

```sh
npm trust github @组织/包名 --file release.yml --repository 组织/仓库 --environment npm --allow-publish
```

文件名、仓库与环境必须和发布 workflow 一致。按 npm 提示完成认证与确认；本包不提供额外 trust 包装命令。配置后运行正常的 OIDC 发布 workflow，让首个真实版本完成首次成功发布。
