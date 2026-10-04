# Renovate 更新 PR（模板仓库自身）

本仓库用 Renovate GitHub App 加 `.github/renovate.json` 维护自身的依赖与工具链更新 PR；根 `.github/dependabot.yml` 已退役。已生成仓库继续保留各自的 Dependabot 文件，不受此配置影响，本仓库也没有替任何生成仓库运行机器人。

## 覆盖范围

内建 manager 直接读取原生声明，不建立第二版本真源：

- `npm`：根 `package.json` 的 `engines.node`、`packageManager`（pnpm）与依赖，含 `pnpm-workspace.yaml` catalog
- `rust-toolchain`：根 `rust-toolchain.toml`
- `cargo`：`Cargo.toml` / `Cargo.lock`
- `github-actions`：`.github/workflows/`
- `dockerfile`：`FROM` 镜像；其中 `.devcontainer/Dockerfile` 的 node 镜像是根 `engines.node` 的静态投影，禁止机器人单独更新，由 `scripts/check-template-toolchain-versions.ts` 漂移门约束

## 审核语义

- 更新 PR 一律不自动合并（`automerge: false`），是否接受以根 check、lint、typecheck 与人工审查为准。
- 跨 Node LTS 大版本（`engines.node` 的 major 更新）必须在 Dependency Dashboard 中显式批准后才创建 PR，不会被普通更新隐式接受。

## 管理员后续操作（尚未执行）

配置文件本身不会启动机器人。需要仓库管理员在 GitHub 上完成：

1. 安装 [Renovate GitHub App](https://github.com/apps/renovate) 并只选择本仓库（或所需仓库范围）。
2. App 启用后参照 [安装和 onboarding 文档](https://docs.renovatebot.com/getting-started/installing-onboarding/) 完成接入：本配置若已在默认分支上，Renovate 可将其视为手动 onboarding（manual/onboard config），不保证会另开 onboarding PR；若确实创建了 onboarding PR，则审核并合并它。此后才会产生更新 PR。
3. 在 Dependency Dashboard issue（[说明](https://docs.renovatebot.com/key-concepts/dashboard/)）中批准或拒绝待处理更新，尤其是 Node 大版本。

修改本配置后可用官方命令本地校验（[配置校验](https://docs.renovatebot.com/config-validation/)）：

```sh
npx --yes --package renovate -- renovate-config-validator --strict --no-global .github/renovate.json
```

注：命令中带显式文件名时必须加 `--no-global`，否则校验器会把它当作全局配置路径。

## 官方依据

- [npm manager](https://docs.renovatebot.com/modules/manager/npm/)（`packageManager` / engines）
- [Node versions](https://docs.renovatebot.com/node/)
- [受支持 managers 列表](https://docs.renovatebot.com/modules/manager/)
