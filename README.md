# dsh-usage-monitor · DSH 使用量监控

> 给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的左侧栏仪表盘插件：把**全部会话**的 token 用量、成本估算、
> 缓存命中率、对话性能、分模型统计，和**本机实例**的实时运行状态（CPU / GPU / 内存 / 运行时长）放进一个面板，
> 并额外提供与 DeepSeek 开放平台账单的**对账**能力。纯本地运行，不上报任何数据。

`Topics: dsh-plugin · deepseek-harness · usage-monitor · token · cost`

```
侧栏图标 → 主面板
├─ KPI          总 Token / 成本（¥，$ 为派生） / 会话数 / 活跃会话 / 缓存命中率 / 请求数
├─ 对账条       全量调用口径 vs 平台账单
├─ 趋势         堆叠柱（未缓存输入/缓存读/缓存写/输出）+ 构成饼图 + 模型占比饼图
├─ 实时          CPU / GPU / 内存 / RSS / heap / 运行时长（2s 轮询 + 60 点 sparkline）
├─ 分会话       可排序、可搜索：token、命中率、TTFT、token 速度、时长
├─ 分模型       请求数、token 分桶、成本
├─ 对话性能     TTFT 分位、平均输出速度、工具耗时占比
├─ 全量调用     按 purpose（对话/压缩/标题/其他）与模型拆分
├─ 平台账单     余额、今日/昨日/7d/30d 消费、采样覆盖度（不全时金额前加 ≥）
├─ 账单历史     日柱状图，覆盖余额账本记录的每一天，含安装本插件之前
└─ 设置与计费规则  官方价表、高峰/谷价时段、法定节假日、汇率位、板块显隐勾选
```

## 特性

- **一个面板看全量**：会话口径 + 全量调用口径 + 平台账单口径并列，谁也不冒充谁。
- **成本估算用官方人民币价目**：元 / 百万 token，**按每次调用发生的时刻**判峰谷再结算；
  峰谷定义与「周末及中国法定节假日全天按谷价」完全按官方说明实现，内置 2025–2026 共 61 天法定节假日。
- **实时汇率、央行口径**：启动后异步拉取中国外汇交易中心（央行授权发布）人民币对中间价，30 分钟刷新；
  失败时按「历史中间价接口 → 非央行市场汇率（明确标注）→ 配置兜底值」四级降级，绝不静默使用旧值。
  人民币是权威基准，美元只是展示派生值，实时汇率**不会回改**已结算的历史成本。
- **自建余额账本**：插件用 DSH 的 `deepseekAccount` 服务采样余额，自己维护按天复式账本
  （`opening / closing / debit / credit`，充值永不冲减消费），所以「每日真实花费」可以跨安装回溯；
  如果本机恰好还有其它 DSH 插件的历史账本文件，会作为**可选回填**逐日合并（观测级合并，不重复计）。
- **可视即配置**：11 个大板块可在面板底部勾选显隐（存 `localStorage`），只影响展示不影响统计。
- **不碰凭据**：账户余额与账单全部经 DSH 的 `deepseekAccount` 服务读取，插件不接触、不存储任何 token / 密码。
- **无第三方依赖**：Host 侧零依赖，浏览器产物只用宿主注入的 React 模块，图表全部手写 SVG。

## 三种口径，不要相加

| 口径 | 数据来源 | 覆盖范围 | 用途 |
|---|---|---|---|
| **会话口径** | 会话日志折叠（`ctx.sessionQuery`） | 本机全部历史会话，含安装本插件之前 | 分会话、分模型、分时段的明细；缓存命中率、TTFT、token 速度 |
| **全量调用口径** | `llm/stream` waterfall 拦截 | 本机全部模型调用，**从插件首次启动起** | 与平台「API requests / Tokens」对齐的那组数 |
| **平台账单口径** | `deepseekAccount.getBalance` 余额采样 + 自建按天账本（可选历史回填） | 该账号下的全部消费，**含其他客户端与设备** | 唯一与开放平台严格一致的消费数字 |

为什么会不一样？

- 会话日志只记录 `assistant/message`，**漏掉** Auto review、会话标题、上下文压缩、联网搜索等辅助模型调用。
  这些 token 真实计费但不产生会话事件；全量调用口径把它们算了回来。
- 开放平台是**账户级**账单：同账号下的其他 API Key、其他机器、其他客户端都算进去，本机日志看不到；
  平台数据还可能有最多 5 分钟延迟。
- 余额差法只在「区间内没有充值」时可信；检测到余额上升会标记为不可信，而不是给出错误数字。

## 安装

需要 **DSH 0.2.x**（Host 提供 `sessionQuery` / `webServer`；`deepseekAccount`、`llm` 是可选服务——缺失时对应卡片显示「不可用」，
其余面板照常）。插件零第三方依赖，不需要 `npm install`。

**三条路径任选**（完整步骤、排错与验证清单见 [`INSTALL.md`](./INSTALL.md)）：

1. **下载即用（推荐给普通用户）**：从 [Releases](https://github.com/Dekurri/dsh-usage-monitor/releases) 下载
   `dsh-usage-monitor-<版本>.tgz` → 解压到一个长期目录 → 在 DSH 插件管理器里
   `install_bundle`，`target` 传该目录的**绝对路径** → 刷新页面。
2. **源码安装（可 `git pull` 升级）**：`git clone https://github.com/Dekurri/dsh-usage-monitor.git`，
   然后把仓库目录的绝对路径交给 `install_bundle`。
3. **交给 AI 助手**：把下面这段直接发给你的 DSH 助手。

````text
把 https://github.com/Dekurri/dsh-usage-monitor 装进当前 DSH profile 并验证：
1. git clone 到 "<绝对路径>"（或下载 Release tgz 解压，得到含 package.json 的目录）
2. plugin_manager({ action:"install_bundle", target:"<插件目录绝对路径>" })
   → 必须 application === "applied"；若 failedAt === "registry"（网络抖动）原样重试一次。
   不要手工改 profile 的 package.json / cordis.patch.yml。
3. cordis_inspect_query({ platform:"client", provider:"Slots", method:"listSubTree",
                           input:{ root:"sidebar.panellist" } })
   → occupants 中应有 { registrant:"usage-monitor", id:"usage-monitor", active:true }
4. GET <DSH Web 地址>/usage-monitor/api/overview?range=today  → 200 且含 kpi
   GET <DSH Web 地址>/usage-monitor/api/live                   → 200 且含 host.cpuPercent
5. 报告已装版本、实际插件目录、上面两项校验结果，并提醒用户刷新页面。
````

安装结果里 `application` 必须是 `"applied"`（`failed` + `failedAt: "registry"` 通常是网络抖动，重试即可）。
卸载：插件管理器里移除 `dsh-usage-monitor`。

## 配置

`cordis.patch.yml` 已给出全部默认值，可在 profile 层覆盖。

| key | 默认 | 含义 |
|---|---|---|
| `fx.USDCNY` | `7.1` | **离线兜底值**：实时汇率取不到时使用（1 美元 = N 元） |
| `fxRefreshIntervalMs` | `1800000` | 实时汇率刷新周期（30 分钟）；中间价约每交易日 09:15 发布 |
| `fxFile` | `$DSH_HOME/usage-monitor/fx.json` | 汇率落盘缓存 |
| `sampleIntervalMs` | `2000` | 系统指标采样周期 |
| `liveHistoryPoints` | `60` | sparkline 环形缓冲点数 |
| `rescanIntervalMs` | `60000` | 非 live 会话的后台重扫周期 |
| `pricing` | 内置官方人民币价表 | 覆盖模型单价（**元 / 1M token**，峰谷两档）；未知模型标 `priced:false` 而不是算错 |
| `pricingHolidays` | `[]` | 追加法定节假日（`'YYYY-MM-DD'` 数组，北京日历日） |
| `accountRefreshIntervalMs` | `60000` | 账户余额刷新周期 |
| `billHistoryFile` | `$DSH_HOME/.dshw-usage.json` | 可选的历史账本文件（只读），仅用于回填安装之前的日期 |
| `cacheFile` / `ledgerFile` / `accountFile` | `$DSH_HOME/usage-monitor/` 下 | 落盘缓存路径 |

## 数据与隐私

- **不上报**：插件不发起任何遥测。唯一的对外网络请求是**取汇率**，且失败可降级：
  1. `chinamoney.com.cn`（中国外汇交易中心，央行授权发布）人民币中间价快照；
  2. 同站的历史中间价接口（快照失败时的备源）；
  3. `api.exchangerate-api.com`（仅当上面都失败时的市场汇率兜底，面板上会明确标注「非央行口径」）。
  全部失败则使用配置里的离线兜底值并标记 `stale`，不会静默使用旧值。
  成本价目表是**编译进包内的官方人民币价目快照**（来源见 `lib/fold.js` 注释），运行时不联网抓价格。
- **不碰凭据**：账户相关全部经 DSH 的 `deepseekAccount` 服务；插件不读 token、不写 cookie、不碰 keychain。
- **只读会话**：不追加、不修改任何会话事件；会话日志始终是唯一真相源。
- **本地缓存**：只存聚合结果（小时桶、会话摘要、余额采样、账本、汇率），落在 `$DSH_HOME/usage-monitor/`。
- 仓库本身不含任何账号、密钥或本机数据；`.gitignore` 已排除各类本地缓存与密钥文件。

## 兼容与已知边界

- 实时运行状态：CPU / 内存 / 进程指标跨平台可用；GPU 依赖 `nvidia-smi`，没有时 `gpu.available:false`（面板静默隐藏显卡块）。
- 法定节假日表内置到 2026 年。官方尚未发布 2027 年放假安排，**未内置年份的工作日 9–12/14–18 会按高峰价计**（可能高估，最多 2 倍）；
  周末仍自动按谷价；可用 `pricingHolidays` 追加新年度日期。
- 平台账单口径依赖账号登录与余额采样；未登录时该卡片显示「不可用 + 原因」，其余面板照常。
- 版本升级时 `CACHE_VERSION` 变化会触发一次全量冷扫（首次打开面板略慢，之后走缓存）。
- UI 的正确性由静态自检（locale 完整性、禁用依赖、loader 结构、主题 token）与真实注册参数核对保证；
  **自动化测试不覆盖视觉渲染**。

## 开发与验证

包内 `tools/` 是可复跑的独立校验脚本（不参与运行时），其中多数需要本机真实会话日志：

```sh
node tools/e2e-host.mjs            # 假 ctx + 真实日志跑通 index.js → routes 全链路
node tools/diff-fold.mjs           # 折叠口径 vs 另一套独立实现，逐会话逐字段比对
node tools/oracle.mjs --json       # 第三套独立实现的全库聚合，用于交叉核对
node tools/contract-check.mjs      # 契约自检（含 getLive / getOverview 延迟门槛）
node tools/ledger-check.mjs        # llm/stream 账本：流原样转发、用量聚合、落盘
node tools/account-check.mjs       # 余额采样、账本回放、登录态降级
node tools/bill-history-check.mjs  # 双源日观测级合并、充值不计消费、乱序忽略
node tools/fx-check.mjs            # 汇率四级降级、脏输入、缓存回环
node tools/ui-selfcheck.mjs        # 浏览器产物静态自检（零依赖，可在 CI 跑）
node tools/assembly-check.mjs      # 装配：五工厂 + 六路由 + 降级路径
```

`tools/` 里的检查脚本会把临时文件写在包内 `.tmp/`（部分沙箱环境拒绝写系统临时目录），跑完自动清理。

接口契约见 [`CONTRACT.md`](./CONTRACT.md)（Host↔Client 唯一契约、字段定义、统计口径与降级规则）。

## 目录结构

```
index.js              Host 入口：装配 collector / llm-ledger / fx / account / bill-history + 路由
lib/fold.js           会话事件折叠（token 分桶、成本、峰谷、节假日）
lib/collect.js        会话扫描、缓存、range/币种视图
lib/system.js         本机实时指标（CPU/GPU/内存/RSS/运行时长/history 环形缓冲）
lib/routes.js         GET /usage-monitor/api/{overview,live,ledger,account,bill-history,fx} + POST /account/login
lib/llm-ledger.js     llm/stream 拦截账本（全量调用口径）
lib/account.js        余额采样 + 自建按天账本（平台账单口径）
lib/bill-history.js   账单历史合并（自建账本优先 + 可选历史回填）
lib/fx.js             央行中间价四级降级与缓存
lib/client.js         浏览器产物（React 组件注册到 sidebar.panellist / main）
cordis.patch.yml      bundle patch（含全部默认配置）
locale/{zh,en}.json   插件显示元数据
INSTALL.md            人类 / AI 助手通用安装与排错说明
tools/                可复跑的独立校验脚本
```

## 许可

[MIT](./LICENSE) © 2026 Dekurri

> 非官方项目，与 DeepSeek 无隶属关系。成本为按官方价目表的**估算值**，与开放平台账单可能存在口径差，请以平台为准。
