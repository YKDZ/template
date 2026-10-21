# 本次首发检查

1. 确认当前提交已推送到 GitHub 公共仓库的默认分支。
2. 检查每个目标的 manifest 版本、CHANGELOG 正文及发布资料。
3. 以 pnpm 原生 `--filter` 选择器传入全部目标；不要依赖自动扩选。
4. 审阅向导列出的目标、版本和制品摘要，再确认 npm 与 GitHub 写入。
5. 两种外部发布均成功后，删除 `scripts/npm-publication-setup/` 和 `.verified-packed-publication/first-release/`。

向导只消费已通过本地安装与包自有测试的 tgz。失败后保留原件并重新运行同一命令续办；若原件不可读，停止处理并人工核实远端事实。
