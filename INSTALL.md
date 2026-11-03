# 安装说明（人类 / AI 助手通用）

本文档给出**可复制执行**的安装步骤，覆盖三种场景：

1. [人类：从 Release 压缩包安装](#1-人类从-release-压缩包安装)（最省事，不需要 git）
2. [人类：从源码安装](#2-人类从源码安装)（可 `git pull` 升级）
3. [AI 助手：按指令自动安装并验证](#3-ai-助手自动安装并验证)（给 agent 的确定性步骤）

> 安装前请确认：**DSH 版本 0.2.x 或更新**。本插件依赖 `webServer` 与 `sessionQuery` 两个 Host 服务
> （`dsh-base` 默认提供），`deepseekAccount` / `llm` 是可选服务——缺失时对应卡片显示「不可用 + 原因」，其余面板照常工作。

---

## 0. 前置检查

在 DSH 里能用到插件管理器即可，插件本身**没有第三方依赖**（Host 侧零依赖，浏览器产物只用宿主注入的 React 模块）。

```sh
# 只需要 Node ≥ 20（DSH 自带即可），不需要 npm install
node -v
```

插件的运行时数据目录是 `$DSH_HOME/usage-monitor/`（Windows 通常 `C:\Users\<你>\.dsh\usage-monitor\`），
首次启用后自动创建：`cache.json`（会话聚合缓存）、`account.json`（余额采样与自建按天账本）、
`llm-ledger.json`（全量调用账本）、`fx.json`（汇率缓存）。**删掉它们不会损坏任何东西**，只是下次打开面板会重新冷扫。

---

## 1. 人类：从 Release 压缩包安装

1. 打开 [Releases](https://github.com/Dekurri/dsh-usage-monitor/releases)，下载最新的 `dsh-usage-monitor-<版本>.tgz`。
2. 解压到**一个长期存在的目录**（不要放在系统临时目录，安装是符号链接，删掉源目录插件就失效了）：

   ```sh
   # macOS / Linux
   mkdir -p ~/dsh-plugins && tar -xzf dsh-usage-monitor-1.0.1.tgz -C ~/dsh-plugins

   # Windows PowerShell
   mkdir "$env:USERPROFILE\dsh-plugins"
   tar -xzf dsh-usage-monitor-1.0.1.tgz -C "$env:USERPROFILE\dsh-plugins"
   ```

   解压后得到 `.../dsh-usage-monitor/package.json`（如果多套了一层 `package/`，把里面那层当作插件目录）。
3. 在 DSH 里安装：调用插件管理器 `plugin_manager`，`action: "install_bundle"`，
   `target` 传上一步目录的**绝对路径**（例如 `/Users/me/dsh-plugins/package` 或 `C:\Users\me\dsh-plugins\package`）。
4. 结果里 `application` 必须是 `"applied"`。若为 `"failed"` 且 `failedAt: "registry"`，多为网络抖动（pnpm 校验依赖时的
   HEAD 请求超时），**原样重试一次**通常就成功。
5. **刷新 DSH 页面**，左侧栏第 4 个图标（柱状图）就是本插件，点进去即面板。

## 2. 人类：从源码安装

```sh
git clone https://github.com/Dekurri/dsh-usage-monitor.git
```

然后用同样方式把**仓库目录的绝对路径**交给 `plugin_manager` 的 `install_bundle`。安装是 symlink 方式，
以后 `git pull` 即更新代码；升级后需要重载插件（见 [重载](#4-升级与重载)），浏览器端刷新页面即可。

---

## 3. AI 助手：自动安装并验证

把下面整段交给具备 DSH 工具能力的助手即可。步骤是确定性的，带成功判据与失败处置。

````text
任务：把 https://github.com/Dekurri/dsh-usage-monitor 安装进当前 DSH profile 并验证可用。

前置：确认 DSH 版本 ≥ 0.2.0（Host 需提供 webServer 与 sessionQuery）。

1) 取代码（二选一）
   a. git clone https://github.com/Dekurri/dsh-usage-monitor.git "<插件目录的绝对路径>"
   b. 或下载 Release 的 dsh-usage-monitor-<ver>.tgz 解压，得到含 package.json 的目录

2) 安装（必须走 DSH 插件管理器，不要手工改 profile 的 package.json / cordis.patch.yml）
   plugin_manager({ action: "install_bundle", target: "<插件目录的绝对路径>" })
   判据：返回 application === "applied"。
   若 application === "failed" 且 failedAt === "registry"（pnpm 访问网络失败）：原样重试一次。
   若仍失败，把 failure/warnings 原文报给用户，不要伪造成功。

3) 校验客户端注册是否 live
   cordis_inspect_query({ platform: "client", provider: "Slots", method: "listSubTree",
                          input: { root: "sidebar.panellist" } })
   判据：occupants 中存在 { registrant: "usage-monitor", id: "usage-monitor", active: true }。
   若 provider 超时，改用下面的 HTTP 校验，并在结论里注明「slot 未验证」。

4) 校验 Host 接口
   GET http://127.0.0.1:<DSH Web 端口>/usage-monitor/api/overview?range=today
   GET http://127.0.0.1:<DSH Web 端口>/usage-monitor/api/live
   判据：HTTP 200；overview 返回含 kpi / series / models / sessions / performance / pricing 的对象；
        live 返回含 host.cpuPercent / process.rssBytes / gpu.available 的对象；延迟应 < 50ms。
   注意：首次请求若在插件启动 1 秒内，可能拿到降级响应（无 kpi 字段），等 1–2 秒重试。

5) 结论
   告诉用户：已装版本、插件目录、sidebar.panellist 是否 active、两个接口的返回码与关键字段；
   并提醒用户「刷新 DSH 页面」才能看到左侧栏图标。
   不要声称视觉已验证——除非真的看到页面。

失败处置：
- 提示缺少服务（inject 不满足）→ 该 profile 没有 webServer / sessionQuery，需启用 dsh-base，不要绕过。
- 提示端口不通 → 端口不是 11331 就换成当前 DSH Web 端口（运行时上下文里有 GUI URL）。
- 账号卡片不可用 → 属正常：该 DSH 未登录 DeepSeek 账号，deepseekAccount 服务不可用；其余面板不受影响。
````

---

## 4. 升级与重载

- **Host 代码**（`index.js`、`lib/*.js`）不会热重载。改完代码后要让 Host 侧生效：

  ```text
  plugin_manager({ action: "set_plugin", target: "include:usage-monitor", enabled: false })
  plugin_manager({ action: "set_plugin", target: "include:usage-monitor", enabled: true })
  ```

  两次都应返回 `application: "applied"`；或者直接重启 DSH。
- **浏览器产物**（`lib/client.js`、`locale/*`）重载插件后**刷新页面**即可。
- 从源码装的话，`git pull` 后同样按上面重载。

## 5. 卸载

```text
plugin_manager({ action: "remove_bundle", target: "dsh-usage-monitor" })
```

或 `set_plugin` 置 `enabled: false` 停用。运行数据目录 `$DSH_HOME/usage-monitor/` 需要时手动删除。

## 6. 装不上的常见原因

| 现象 | 原因 | 处置 |
|---|---|---|
| `application: "failed"`，`failedAt: "registry"` | pnpm 拉取/校验网络失败 | 原样重试；确认代理可用 |
| 装成功但侧栏没有图标 | 浏览器未刷新，或客户端 bundle 未加载 | 刷新页面；查 `sidebar.panellist` 是否有 `usage-monitor` |
| 侧栏有图标但面板空白 | 客户端 slot 崩溃 | 看浏览器控制台是否有 `slot entry crashed`；把日志给维护者 |
| 面板能开但数字全 0 | 新 profile 没有历史会话 | 正常；产生一次对话后即可看到数据 |
| `平台账单` 卡显示不可用 | 未登录 DeepSeek 账号（`deepseekAccount` 不可用） | 在 DSH 里登录后自动恢复，其余卡片不受影响 |
| GPU 始终 `available: false` | 无 NVIDIA 显卡 / 无 `nvidia-smi` | 正常，显卡块静默隐藏 |

## 7. 验证清单（装完可以自己确认）

```text
GET /usage-monitor/api/overview?range=today    → 200，有 kpi
GET /usage-monitor/api/live                    → 200，host.cpuPercent 在 0–100
GET /usage-monitor/api/ledger?range=today      → 200，available 字段存在（有 llm 服务时为 true）
GET /usage-monitor/api/account                 → 200，signedIn true/false 且 diag 有说明
GET /usage-monitor/api/bill-history?range=7d   → 200，days 数组
GET /usage-monitor/api/fx                      → 200，rate 为数字、source 说明来源
```

仓库内 `tools/` 还有 13 个可复跑的校验脚本，见 README 的「开发与验证」。
