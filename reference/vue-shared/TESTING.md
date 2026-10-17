# 测试约定

包含逻辑测试的包通过 `pnpm test` 使用 Vitest 的 `node` 项目运行测试；`pnpm test:browser` 使用 `browser` 项目在 Chromium 中运行组件测试。Vitest Browser Mode 通过 Playwright provider 启动真实浏览器，测试文件按运行环境命名：`*.node.test.ts` 和 `*.browser.test.ts`。

可复用的业务逻辑、状态管理和纯函数放在 Node 测试中。组件测试通过 `vitest-browser-vue` 渲染真实 Vue 组件，优先按角色和可访问名称查找控件，再执行点击、输入等用户操作并检查可见结果。默认 `render` 会在下个测试开始前清理组件；按组件真实需要配置插件，若使用 Pinia，每个测试都应创建独立实例，避免测试之间共享状态。

`pnpm test` 与 `pnpm test:browser` 选择互斥项目。Playwright Test 的 `pnpm test:e2e` 用于覆盖跨页面、服务或持久化流程中的关键用户旅程；组件内部的交互由 Browser Mode 验证，避免在端到端测试中重复这些细节。
