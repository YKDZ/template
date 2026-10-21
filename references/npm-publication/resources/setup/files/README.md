# 首次 npm 发布与 GitHub Release

在已提交、已推送的默认分支上，为一个或多个已启用共享发布能力的包运行：

```sh
pnpm run publication:setup -- --filter @组织/包名
```

每个目标重复传入 `--filter`；选择器由 pnpm 原生解析。目标版本直接取自各自的 `package.json`。准备前要求工作区干净，且当前提交与远端默认分支一致。命令会先为全部目标生成并安装验收原始 tgz，再列出目标与 SHA-512。确认后依次运行共享 npm 整批调度和就绪目标的 GitHub Release 调度。预发布版本会分别询问 npm dist-tag。

向导不会更改源码、文档或提交，也不会创建分支、commit、push 或 PR。pnpm、npm 与 GitHub CLI 使用你本机的正常认证方式；向导不会读取或保存发布令牌。

如果 npm 或 Release 中途失败，不要删除 `.verified-packed-publication/first-release`。再次运行 `pnpm run publication:setup` 会从原 accepted 清单和 tgz 继续；缺少或损坏的原件会使流程停止，不会重新打包替代。

首个 npm 版本和 GitHub Release 均完成后，可以删除本目录。下一次真实版本发布前，请按共享发布包 README 配置 npm Trusted Publisher。
