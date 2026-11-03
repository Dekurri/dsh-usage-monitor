# AGENTS.md — 给 AI 助手的仓库说明

你在看一个 **DeepSeek Harness (DSH)** 的第三方插件仓库。本文件是给 agent 的快速上手与约束说明；
给人看的文档是 [`README.md`](./README.md)，安装细节与排错见 [`INSTALL.md`](./INSTALL.md)，接口契约见 [`CONTRACT.md`](./CONTRACT.md)。

## 这是什么

`dsh-usage-monitor` 是一个 DSH **bundle 插件**（同时含 Host 与浏览器两半）：

- Host：`index.js` + `lib/*.js`，注册 6 条 web 路由，聚合会话日志 token、拦截 `llm/stream` 账本、采样余额与系统指标。
- Client：`lib/client.js`，浏览器产物，注册到 `sidebar.panellist`（左侧栏图标）与 `main`（主面板）。

运行时零第三方依赖；Host 侧不写会话事件、不碰凭据。

## 你想把它装进 DSH 时，照这个顺序做

1. 取代码：`git clone https://github.com/Dekurri/dsh-usage-monitor.git <绝对路径>`，
   或下载 Release 的 `dsh-usage-monitor-*.tgz` 解压得到含 `package.json` 的目录。
2. 安装：`plugin_manager({ action: "install_bundle", target: "<插件目录绝对路径>" })`。
   **必须走插件管理器**，不要手工改 profile 的 `package.json` / `cordis.patch.yml`。
   判据：`application === "applied"`。若 `failedAt === "registry"`（pnpm 网络抖动）原样重试一次。
3. 校验注册：`cordis_inspect_query({ platform: "client", provider: "Slots", method: "listSubTree", input: { root: "sidebar.panellist" } })`
   → `occupants` 中应有 `{ registrant: "usage-monitor", id: "usage-monitor", active: true }`。
4. 校验接口：`GET <DSH Web 地址>/usage-monitor/api/overview?range=today` → 200 且含 `kpi`；
   `GET .../api/live` → 200 且含 `host.cpuPercent`。插件启动 1 秒内的首个请求可能是降级响应，等 1–2 秒重试。
5. 报告：已装版本、插件目录、上面两项结果；提醒用户**刷新页面**。**不要声称视觉已验证**——除非真的看到页面。

## 改代码时

- **Host 代码不热重载**。改完要重载：`plugin_manager({ action:"set_plugin", target:"include:usage-monitor", enabled:false })`
  再 `enabled:true`（两次都应 `applied`），或重启 DSH。浏览器产物改完刷新页面即可。
- 环境变量 `DSH_HOME` 决定数据目录，默认 `~/.dsh`；运行时数据在 `$DSH_HOME/usage-monitor/`（可安全删除，会重新冷扫）。
- 本地校验（多数需要本机真实会话日志）：

  ```sh
  node --check index.js && for f in lib/*.js; do node --check "$f"; done
  node tools/ui-selfcheck.mjs     # 浏览器产物静态自检（无外部依赖，CI 也跑这个）
  node tools/e2e-host.mjs         # 假 ctx + 真实日志：装配 → 折叠 → 6 条路由端到端
  node tools/diff-fold.mjs        # 折叠口径 vs 独立实现逐会话逐字段比对
  node tools/contract-check.mjs   # 契约自检（含延迟门槛）
  ```
- 临时文件写包内 `.tmp/`（部分沙箱拒绝写系统临时目录），跑完清理；不要把 `.tmp/`、缓存 JSON 提交进仓库。

## 硬约束（违反会出问题）

1. **不要用新的会话事件 `type` 往会话里追加数据**——会话将无法重开。
2. **不要改统计口径而不改 `CONTRACT.md`**：token 四桶、缓存命中率分母、峰谷与节假日判定、三种口径不可相加，
   这些都写在 `CONTRACT.md` 里，是验收依据。
3. **不要在 Client 里 import 任何 `@deepseek-ai/dsh-*` 包**（只允许 `require('react')`），主题只能用 `--dsw-alias-*` token。
4. **不要往 `document.body` 追加节点、不要 iframe 嵌 Host 页面**；UI 必须作为 slot 组件渲染。
5. **不要提交任何本机数据**：缓存 JSON、`*.jsonl*`、`.dshw-usage.json`、会话日志、账号信息都在 `.gitignore` 里。
6. 发版走 tag：`git tag -a vX.Y.Z && git push origin vX.Y.Z`，`.github/workflows/release.yml` 会自动打包并建 Release。
