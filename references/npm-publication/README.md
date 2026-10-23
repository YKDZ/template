# npm 原生发布

本参考内容为相关工作区提供 Changesets 配置、原生发布命令和 GitHub Actions 工作流。ts-lib 与 ts-cli 默认组合这份配置；新增配置不会公开任何包。包是否发布由自己的 `package.json` 决定，默认保持 `private: true`。

## 准备版本

准备发布时，在目标包的 `package.json` 中设置真实包名和版本，并将 `private` 改为 `false`；维护该包的 `CHANGELOG.md`，使用 `## <完整版本号>` 作为版本标题。可直接维护 manifest 版本；Changesets 的变更集与 `changeset version` 也是可选用法。

首次发布时，先用 `npm login` 登录，再按相同的 Changesets 路径执行 `pnpm publication:pack` 和 `pnpm publication:publish`。Changesets 按原生规则处理待发布包、依赖顺序与已发布版本。首次上传成功后，在 npm 包设置中添加 GitHub Actions Trusted Publisher，填写实际仓库、工作流 `release.yml` 和环境 `npm`；在 GitHub 仓库中创建对应环境。

## 后续发布

提交并审核版本、说明和 manifest 变更后，在仓库默认分支手动运行 `release.yml`，也可执行 `gh workflow run release.yml --ref <默认分支>`。工作流先在只读作业中检查、构建、打包和验收，再由官方 Changesets 发布 Action 上传同一份 artifact 并创建 GitHub Release。发布作业通过 npm OIDC 认证；合并、普通 push、tag 或 Release 创建不会自动上传 npm。

官方 Action 从每包 `CHANGELOG.md` 读取 Release 说明。缺少该文件时会跳过 GitHub Release；文件存在但没有匹配完整版本的标题时，Action 可能会将整份文件作为说明。因此，维护者应保留 `## <完整版本号>` 标题，但不需要另加说明解析器或格式门禁。

发布失败后，先查看 Actions 日志，并分别核对 npm 版本和 GitHub Release 是否已创建；之后按 Changesets、npm 和 GitHub 的原生行为诊断或补齐。不要假设重跑会自动恢复所有已完成阶段。

参考：[Changesets 自动化](https://changesets.dev/guide/automating)、[npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers)。
