# 首次 npm 发布

此目录只提供一次性首次发布向导。生成仓库的长期发布 workflow 与远端发布实现来自共享 `@ykdz/reference-npm-publication`。

在生成仓库根目录运行 `./scripts/npm-publication-setup/setup.sh`。向导先确认公开包资料，再要求默认分支干净且与公共远端同步；随后通过正式准备、安装和消费验收得到唯一 tgz。发布说明取自目标包当前版本的 `CHANGELOG.md`。

稳定版默认使用 npm `latest` 标签。预发布版本须通过 `--dist-tag <channel>` 显式提供非 `latest` 渠道。npm 上传后 pnpm 会等待准确版本可见，后续 GitHub Release 复用同一 tgz。

远端步骤失败时，向导保留已验收目录并打印 `--resume-artifact <目录>` 续办命令；预发布续办还需保留 `--dist-tag <channel>`。续办读取原回执、tgz 和原提交，不重新准备制品。原件丢失或远端事实冲突时停止。

`./scripts/npm-publication-setup/setup.sh --status --json` 只读取本地状态，不会创建制品或访问发布服务。
