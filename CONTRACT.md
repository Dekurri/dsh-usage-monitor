# dsh-usage-monitor 接口契约（Host ↔ Client 唯一真相）

> 本文件是 Host 侧与 Client 侧唯一的共享契约。两侧实现都必须逐字遵守字段名与类型。
> 修改契约必须先改本文件，再改两侧实现。

## 1. 包结构

```
dsh-usage-monitor/
  package.json            (Lead)
  cordis.patch.yml        (Lead)
  icon.svg                (Lead)
  locale/en.json zh.json  (Lead)
  index.js                (Lead, Host 门面：apply + 装配)
  lib/collect.js          (host-data, Node ESM, 纯计算 + 采集器)
  lib/fold.js             (host-data, 纯函数：事件 → 会话摘要，可独立 node 跑)
  lib/system.js           (host-data, 系统指标采集)
  lib/routes.js           (host-data, HTTP 路由注册)
  lib/client.js           (client-ui, 浏览器产物)
  tools/*.mjs             (host-data, 独立验证脚本，不进运行时)
```

Host 侧全部是 **Node ESM**（`type: module`），只能 `import 'node:*'` 或相对路径，
**不得** import 任何 `@deepseek-ai/*` 包。Client 侧是浏览器产物，
**不得** import 任何 `@deepseek-ai/*` 包（React / react-dom 从 `require()` 模块表取）。

## 2. HTTP 路由（Host 注册，Client 轮询）

前缀常量 `BASE = '/usage-monitor/api'`。均为 `GET`，返回
`Content-Type: application/json; charset=utf-8` + `Cache-Control: no-store`。
错误：`500 { error: string }`。所有数字单位见各字段注释。

### 2.1 `GET /usage-monitor/api/overview?range=today|24h|7d|14d|30d|all&currency=CNY|USD`

> `range` 缺省/非法 → `24h`（滚动近 24 小时）。`today` = **本地时区当天 00:00 → 现在**，按小时出桶（1–24 个，label `HH:00`）；`series.granularity` 为 `hour`。
> `currency` 缺省/非法 → `CNY`（**人民币是权威基准**，USD 由 `costCNY / fxRate` 派生）。
> **v3 币种口径**：每个含成本的行/桶统一给三字段 `cost`（请求币种；默认 CNY）/ `costCNY`（权威）/ `costUSD`（派生）。

```jsonc
{
  "generatedAt": 1700000000000,        // ms epoch
  "range": { "key": "7d", "from": 1700000000000, "to": 1700000000000, "label": "近 7 天" },
  "fx": {                                              // 币种基准 + 汇率来源元数据（v4）
    "baseCurrency": "CNY",                             // CNY 是唯一权威基准
    "usdCnyRate": 6.7146,                              // 1 USD = N CNY；实时央行中间价优先，否则配置兜底
    "source": "pboc-cfets",                            // pboc-cfets | pboc-cfets-history | market | config
    "sourceLabel": "中国人民银行授权·CFETS 人民币汇率中间价",
    "effectiveDate": "2026-11-02",                     // 中间价生效日（未拿到时为 null）
    "fetchedAt": 1700000000000,                        // 最近一次成功抓取时间；0 = 从未
    "stale": false                                     // true = 当前值为旧值/兜底值
  },
  "scan": {
    "sessionsTotal": 128,   // 全库会话数（不限时段）
    "sessionsInRange": 42,  // 时段内有活动的会话数
    "scanned": 128,         // 已折叠的会话数
    "cached": 120,          // 命中缓存未重读日志的会话数
    "errors": 0,            // 读取失败的会话数
    "scanning": false,      // 后台扫描是否进行中
    "lastScanAt": 1700000000000
  },
  "kpi": {
    "totalTokens": 0,          // 全部 token（uncachedInput + cacheRead + cacheWrite + output）
    "uncachedInputTokens": 0,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "outputTokens": 0,
    "reasoningTokens": 0,
    "cacheHitRate": 0,         // 0..1 = cacheRead / (cacheRead + uncachedInputTokens + cacheWriteTokens)；分母 0 → 0
    "cost": 0,                 // 按请求币种换算后的金额（默认 CNY）
    "costCNY": 0,              // 权威：人民币金额
    "costUSD": 0,              // 派生：costCNY / fxRate
    "currency": "CNY",         // 缺省 CNY；USD 时 cost === costUSD
    "fxRate": 7.1,             // USD→CNY 汇率（实时中间价优先，配置兜底；USD 由它派生）
    "sessions": 42,            // 时段内会话数
    "activeSessions": 2,       // 当前 live 会话数（不受时段限制）
    "turns": 0,
    "steps": 0,
    "requests": 0,             // assistant/message 条数
    "toolCalls": 0,
    "avgTokensPerSession": 0,
    "avgTokensPerTurn": 0,
    "avgTtftMs": 0,            // 首 token 延迟均值
    "tokensPerSec": 0,         // 输出 token 速度均值
    "tokensPerMin": 0          // 最近 60s 的全局输出 token 速率
  },
  "series": {
    "granularity": "hour",     // "hour" | "day" | "week"（today/24h=hour）
    "buckets": [
      { "t": 1700000000000, "label": "14:00",
        "uncachedInputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0,
        "outputTokens": 0, "reasoningTokens": 0, "totalTokens": 0,
        "cost": 0, "costCNY": 0, "costUSD": 0, "sessions": 0, "requests": 0 }
    ]
  },
  "models": [
    { "provider": "deepseek", "model": "deepseek-chat", "requests": 0,
      "totalTokens": 0, "uncachedInputTokens": 0, "cacheReadTokens": 0,
      "cacheWriteTokens": 0, "outputTokens": 0, "reasoningTokens": 0,
      "cost": 0, "costCNY": 0, "costUSD": 0, "cacheHitRate": 0, "avgTtftMs": 0, "tokensPerSec": 0,
      "priced": true }        // false = 无价格数据，成本按 0 计并在 UI 标注
  ],
  "sessions": [
    { "id": "session-xxx", "title": "…", "cwd": "D:\\x", "createdAt": 0, "lastActivityAt": 0,
      "live": true, "turns": 0, "steps": 0, "requests": 0, "toolCalls": 0,
      "totalTokens": 0, "uncachedInputTokens": 0, "cacheReadTokens": 0,
      "cacheWriteTokens": 0, "outputTokens": 0, "reasoningTokens": 0,
      "cost": 0, "costCNY": 0, "costUSD": 0, "cacheHitRate": 0, "avgTtftMs": 0, "tokensPerSec": 0,
      "models": ["deepseek-chat"], "agentPreset": null, "parentSession": null,
      "origin": null, "delegationDepth": 0 }
  ],
  "performance": {
    "ttft": { "avg": 0, "p50": 0, "p90": 0, "samples": 0 },
    "tokensPerSec": { "avg": 0, "p50": 0, "p90": 0, "samples": 0 },
    "toolMs": 0, "llmMs": 0, "toolShare": 0,   // toolShare = toolMs / (llmMs + toolMs)
    "cacheHitRate": 0,
    "requestsPerTurn": 0,
    "toolCallsPerTurn": 0,
    "errorTurns": 0, "interruptedTurns": 0, "totalTurns": 0
  },
  "pricing": {
    "source": "builtin", "updatedAt": 0, "count": 12,
    "baseCurrency": "CNY",
    "peakHoursUtc": [[1, 4], [6, 10]], "peakWeekdays": "Mon-Fri", "offPeakHalfPrice": true,
    "holidaysIncluded": true, "holidayYears": [2025, 2026], "holidayDays": 61,
    "holidayExtraCount": 0, "holidaySource": "builtin: …",
    "holidayNote": "周末与中国法定节假日全天按谷价；未内置年份（如 2027）会按峰价计。"
  }
}
```

### 2.2 `GET /usage-monitor/api/live`（Client 每 2s 轮询，必须 <50ms 返回）

```jsonc
{
  "generatedAt": 0,
  "uptime": { "processMs": 0, "hostMs": 0 },
  "process": { "pid": 0, "cpuPercent": 0, "rssBytes": 0, "heapUsedBytes": 0, "heapTotalBytes": 0, "threads": 0 },
  "host": { "cpuPercent": 0, "cores": 16, "loadAvg": [0,0,0], "memUsedBytes": 0, "memTotalBytes": 0, "memPercent": 0, "freeMemBytes": 0 },
  "gpu": { "available": false, "name": null, "utilPercent": 0, "memUsedBytes": 0, "memTotalBytes": 0, "memPercent": 0, "tempC": 0, "powerW": 0 },
  "counters": { "sessionsTotal": 0, "activeSessions": 0, "totalTokens": 0, "cacheHitRate": 0, "costCNY": 0, "costUSD": 0, "tokensPerMin": 0, "requestsPerMin": 0 },
  "history": { "cpu": [0], "gpu": [0], "mem": [0], "tokensPerMin": [0] }   // 各 60 点，最旧→最新，点间隔 2s
}
```

> `history` 是 Host 侧维护的环形缓冲（60 点）；Client 直接画线，不自己累积。

## 3. Host 内部模块边界（谁导出什么）

### `lib/fold.js`（纯函数，无 ctx，可 `node --check` / 单测）
```js
export function emptySessionStats(header, pricing?, holidays?) -> SessionStats
export function foldEvent(stats, event) -> void|SessionStats   // 原地累积或返回新对象，实现自选，但必须纯净
export function newTurnState() -> TurnState
export function priceFor(model, prices, timeMs?, holidays?) -> {input, cacheRead, cacheWrite, output}|null   // CNY / 1M token；第三参缺省按 peak
export function costOf(tokens, price) -> number   // CNY
export function isPeakHour(timeMs, holidays?) -> boolean   // 工作日高峰窗；周末与法定节假日全天 false
export function isChinaHoliday(timeMs, holidays?) -> boolean   // 按北京日历日
export function holidaySetOf(extra?) -> Set<string>   // 内置 2025/2026 + 追加项
export const PEAK_HOURS_UTC = [[1,4],[6,10]]
export const PEAK_WEEKDAYS = 'Mon-Fri'
export const PRICING_BASE_CURRENCY = 'CNY'
export const CN_HOLIDAY_DAYS = ['2025-01-01', …]   // 2025–2026 共 61 天（来源 holiday-cn）
export const CN_HOLIDAY_YEARS = [2025, 2026]
export const PRICING_HOLIDAY_SOURCE = 'builtin: …'
export const BUILTIN_PRICING = { [model]: { peak: {...}, offPeak: {...} } }
```
`SessionStats` 是本模块内部结构，**不直接暴露给 Client**；由 `collect.js` 转成契约 §2.1 的形状。

### `lib/collect.js`
```js
export function createCollector(ctx, config, deps?) -> {
  getOverview({ range, currency }): Promise<Overview>   // 契约 §2.1
  getLive(): Live                                        // 契约 §2.2，同步、非阻塞
  invalidate(sessionId?): void
  start(): void        // 启动后台全量扫描
  dispose(): void
}
// deps（v4，可选）：{ fxRate?: { getRate(): FxRateView } } —— 只用于派生 USD 展示与 fx 元数据。
```
- 数据来源：`ctx.sessionQuery.listSessions()` / `.observeSession(id, {projectionMode:'none'})`
  或 `.readSession(id)`（host-data 自行确认可用方法名并记录在 `lib/collect.js` 顶部注释）。
- 增量：按 `头信息 + 事件条数/最后 seq + 文件修订` 判断是否需要重读；内存缓存 + 可选落盘缓存
  （`config.cacheFile`，默认 `dshHomePath('usage-monitor/cache.json')` 由 Lead 传入）。
- 实时：`ctx.on('session/event', …)` 把 live 会话的新事件增量折叠进缓存（不要重扫）。
- 广播：`ctx.on('dispose', …)` 清理。
- **v4 汇率**：`fx` 块与 `kpi.fxRate` 每 2s 视图取一次 `deps.fxRate.getRate()`（同步、无 IO）；USD 派生 = `costCNY / usdCnyRate`。**绝不用实时汇率重算历史成本**。

### `lib/system.js`
```js
export function createSystemSampler(intervalMs) -> { sample(): LiveSystem, history: {...}, dispose(): void }
export function runNvidiaSmi() -> Promise<object|null>   // 无 nvidia-smi 时 resolve null，不抛
```
CPU 用 `os.cpus()` 两次采样差；内存用 `os.totalmem/freemem + process.memoryUsage()`；
GPU 用 `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`（子进程，2s 缓存，失败静默禁用）。

### `lib/fx.js`（v4，实时央行中间价汇率）
```js
export function defaultFxCacheFile() -> string                    // $DSH_HOME/usage-monitor/fx.json
export function parseCfetsSnapshot(payload) -> { rate, effectiveDate }|null      // 主源 ccpr.json
export function parseCfetsHistory(payload) -> { rate, effectiveDate }|null       // 备源 CcprHisNew
export function parseMarketSnapshot(payload) -> { rate, effectiveDate }|null     // 第三方市场汇率
export function createFxRate(ctx, options) -> {
  getRate(): FxRateView      // 同步、绝不抛、绝不发请求
  refresh(): Promise<FxRateView>   // 手动刷新，绝不 reject
  start(): void              // 读缓存 + 起 unref 定时器；构造期无 IO
  dispose(): void            // 幂等
}
export const FX_SOURCES = ['pboc-cfets', 'pboc-cfets-history', 'market', 'config']
```
- `options = { cacheFile?, refreshIntervalMs?=1800000, configRate?=7.1, timeoutMs?=8000, logger? }`。
- 数据源优先级与刷新策略见 §7.9；**构造期零 IO/零请求**，`apply()` 里不得同步联网。

### `lib/routes.js`
```js
export function registerUsageRoutes(ctx, collector, disposers, extras?) -> void
// extras = { ledger?, account?, billHistory?, fxRate? }，每个字段都可能为 null。
```
内部：`const off = ctx.webServer.register({ kind:'exact', path: BASE+'/overview', handler }); disposers.push(off)`。
必须自己解析 `req.url` 的 query（`new URL(req.url, 'http://localhost')`），必须 try/catch 兜 500。
v4 起注册 **7 条 exact 路由**：`/overview`、`/live`、`/ledger`、`/account`、`/account/login`、`/bill-history`、`/fx`。

### `index.js`（Lead，已写好，不要改）
```js
export const inject = ['webServer', 'sessionQuery', 'sessions']   // 三者都已确认挂载
export function apply(ctx, config) {
  collector = createCollector(ctx, config ?? {})
  collector.start()
  registerUsageRoutes(ctx, collector, disposers)   // disposers 数组由 index.js 传入
  ctx.effect(() => () => { /* pop + call disposers, collector.dispose() */ })
}
```

## 5. Host 行配置（`cordis.patch.yml` 已写默认值，每个 key 都必须在代码里有同样默认值）

| key | 默认 | 含义 |
|---|---|---|
| `fx.USDCNY` | `7.1` | **最终兜底 / 离线** USD→CNY 汇率。运行时 Host 会抓取央行授权 CFETS 中间价（§7.9）替代它做展示；CNY 是权威基准，USD 展示值 = `costCNY / 实时汇率`。**不得用它重算历史成本** |
| `fxRefreshIntervalMs` | `1800000`（30 分钟） | 抓取 CFETS 中间价的周期（ms）；中间价每日约 09:15 北京时间发布 |
| `fxFile` | 自动 | 汇率缓存路径；默认 `$DSH_HOME/usage-monitor/fx.json`（原子写，24h 内有效） |
| `sampleIntervalMs` | `2000` | 系统采样周期 |
| `liveHistoryPoints` | `60` | 每张 sparkline 的环形缓冲点数 |
| `rescanIntervalMs` | `60000` | 后台重扫周期（只对非 live 会话；live 会话靠事件增量） |
| `pricing` | 内置表 | 覆盖模型单价（**CNY / 1M token**，峰谷两档），支持扁平 `{ "deepseek-flash": { "cacheRead": 0.04, "cacheMiss": 2, "output": 8 } }` 或 `{ peak: {...}, offPeak: {...} }` |
| `pricingHolidays` | `[]` | 追加中国法定节假日（`'YYYY-MM-DD'` 字符串数组，按北京日历日）；内置 2025/2026 共 61 天（来源 holiday-cn），用于新年度官方安排发布后补录。节假日全天按谷价 |
| `cacheFile` | 自动 | 落盘缓存路径；默认 `$DSH_HOME/usage-monitor/cache.json`，`DSH_HOME` 取 `process.env.DSH_HOME`，缺省 `os.homedir()/.dsh` |

`collector.dispose()` 必须幂等（可能被调用两次）；`createCollector` 不得在构造期做 IO。

## 4. Client 侧（`lib/client.js`）

```js
window.__ModuleLoader__.load({ id: 'dsh-usage-monitor', factory(require) { … return { inject: [...], apply(ctx) {…} } } })
```
- 注册面板入口：`sidebar.panellist` 列表 slot，`{ id: 'usage-monitor', order: 60, label: () => t('panel.title') }`
- 注册主面板：`main` keyed slot，`{ key: 'usage-monitor' }`（**key 必须与 panellist id 相同**）
- 文案全部走 `ctx.locale`（`register`/`bind`），**不得硬编码中文或英文**
- 颜色只用 `--dsw-alias-*` 主题 token；图表用内联 SVG，**不得**引入图表库或 iframe
- 轮询：`/overview` 每 30s + range/currency 变化时立刻拉；`/live` 每 2s（仅面板可见时）
- 组件拆分（同一文件内）：`Dashboard` / `KpiCard` / `BarChart` / `PieChart` / `Gauge` / `Sparkline` / `SessionTable` / `ModelTable` / `RangeTabs` / `CurrencyToggle`
- 首帧必须渲染骨架屏，不得白屏；任何请求失败显示可重试的错误条，不抛异常

## 6. 真实数据口径（从 75 个真实 v4 会话日志实测，两侧都必须遵守）

### 6.1 token 分桶（最关键）
`assistant/message` 的 `data.usage` 实测样例：
```json
{"inputTokens":957,"outputTokens":1538,"cacheReadTokens":726528,"cacheWriteTokens":0,"totalTokens":729023}
```
- `totalTokens === inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`（729023 = 957+1538+726528+0，精确相等）
- ⚠️ **`inputTokens` 是「未缓存输入」，不是总输入**。总输入 = `inputTokens + cacheReadTokens + cacheWriteTokens`
- 因此 `cacheHitRate = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`，分母为 0 时记 0（不是 1）
- 成本按四档算：未缓存输入 / 缓存读 / 缓存写 / 输出
- 全库 6193 条带 usage 的 `assistant/message`，其中 6171 条 `cacheReadTokens > 0`

#### 6.1b 峰谷定价、中国法定节假日与币种基准（v5，成本口径）

DeepSeek 官方是**峰谷定价**，`off-peak = peak / 2`。**内置价表直接采用官方发布的人民币价目**（CNY / 1M tokens，2026-11-03 抓自 https://api-docs.deepseek.com/zh-cn/quick_start/pricing ，**估算值、可能过时**）：

| model | 缓存命中 cacheRead | 缓存未命中 input / cacheWrite | 输出 |
| --- | --- | --- | --- |
| `deepseek-flash`（peak，高峰） | 0.04 | 2 | 8 |
| `deepseek-flash`（off-peak，谷价） | 0.02 | 1 | 4 |
| `deepseek-v4-pro`（peak，高峰） | 0.30 | 9 | 27 |
| `deepseek-v4-pro`（off-peak，谷价） | 0.15 | 4.5 | 13.5 |

- **高峰/空闲时段（官方脚注原文）**：「空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。」换算成 UTC 即高峰窗 01:00–04:00 / 06:00–10:00。
- **中国法定节假日**：`lib/fold.js` 内置 `CN_HOLIDAY_DAYS`（2025–2026 共 61 天，来源 github.com/NateScarlet/holiday-cn 的 `isOffDay=true`），按**北京日历日**判定；`config.pricingHolidays` 可追加新年度日期。2027 起官方安排未发布、未内置 → 该年节假日会按 peak 计（已知高估，最多 2 倍）。调休上班的周六/周日仍按周末判 off-peak。
- **CNY 是唯一权威基准**：`BUILTIN_PRICING` 与 `costOf()` 全部返回 CNY；USD 只是展示派生值（`costUSD = costCNY / fxRate`，`fxRate` 来自 §7.9 实时中间价，兜底 `config.fx.USDCNY`）。`config.pricing` 覆盖表**一律视为 CNY 表**。
- **公式**：`costCNY = (uncached * input + cacheRead * cacheReadPrice + cacheWrite * cacheWritePrice + output * outputPrice) / 1e6`；四档单价按**该条 usage 事件发生时刻**（`event.time`）用 `priceFor(model, pricing, eventTime, holidays)` 选 peak/off-peak 档（节假日优先 off-peak）。
- **按事件时间分桶**：小时桶的 `costCNY` 是该小时内所有采样按各自事件时间成本之和；`totals.cost` / `totals.costCNY` = 各桶之和（不是先聚合区间 token 再乘单价）。
- `lib/fold.js` 新增导出：`CN_HOLIDAY_DAYS`、`CN_HOLIDAY_YEARS = [2025, 2026]`、`PRICING_HOLIDAY_SOURCE`、`isChinaHoliday(timeMs, holidays?)`、`holidaySetOf(extra?)`；`isPeakHour(timeMs, holidays?)` 与 `priceFor(model, prices, timeMs?, holidays?)` 增加可选 holidays 参数（缺省用内置表）。
- **向后兼容**：`config.pricing` 扁平 `{input, cacheRead, cacheWrite, output}`（v1/v2 写法）视为 peak CNY 价、off-peak 自动减半；`{peak, offPeak}` 直接采用。`priceFor` 的 timeMs 缺省/非有限数按 peak 计价（兼容旧调用）。
- `getOverview().pricing` 字段：`source/updatedAt/count` + `baseCurrency: 'CNY'`、`peakHoursUtc`、`peakWeekdays`、`offPeakHalfPrice: true`、`holidaysIncluded: true`、`holidayYears: [2025,2026]`、`holidayDays: 61`、`holidayExtraCount`、`holidaySource`、`holidayNote`。
- `lib/llm-ledger.js` 的 `totals.costCNY` 同样按小时桶起点判定峰谷（并经 `holidaySetOf(options.pricingHolidays)` 传节假日），口径与 overview 一致。旧别名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 按 `deepseek-flash` 计价。

### 6.2 分模型
`message.source = {"kind":"model","provider":"deepseek-account","model":"deepseek-flash",...}` → 分模型键取 `provider` + `model`。

### 6.3 流式事件形状（算 TTFT / token 速度用）
`data.stream` 是**扁平数组**，元素有两种形态：带 `.chunk` 包装的 `type:'chunk'`，和内容直接在元素上的 `*-chunks`。
```jsonc
{ "type":"chunk", "time":<ms>, "chunk":{ "type":"block-start", "index":0, "blockType":"reasoning"|"text"|"tool-call" } }
{ "type":"chunk", "time":<ms>, "chunk":{ "type":"block-end", "index":0, "block":{…} } }
{ "type":"chunk", "time":<ms>, "chunk":{ "type":"usage", "usage":{…} } }        // 与 data.usage 相同，可交叉校验
{ "type":"chunk", "time":<ms>, "chunk":{ "type":"finish", "reason":{"kind":"tool-calls"}, "replayState":{…} } }
{ "type":"reasoning-chunks", "time0":<ms>, "index":0, "dt":[…], "texts":[…] }
{ "type":"text-chunks",      "time0":<ms>, "index":1, "dt":[…], "texts":[…] }
{ "type":"tool-call-chunks", "time0":<ms>, "index":2, "id":"call_…", "name":"ops_glob", "args":[…] }
```
- **只有 `type:'chunk'` 的元素内容在 `.chunk`；`*-chunks` 元素的内容直接在元素上**（`time0`/`dt`/`texts`/`args`），没有 `.chunk` 包装
- **TTFT** = 第一条 `texts` 非空的 `*-chunks` 元素的 `time0` − 该 step 的 `step/start` 时间（`dt` 是该组内 token 间隔毫秒）
- **decode 窗口** = `assistant/message` 的 `time` − 首个 token `time0`
- 实测全库：avgTtftMs ≈ 1342ms，tokensPerSec ≈ 193

### 6.3b tool 墙钟配对（`tool/result` 没有 `data.callId`）
```jsonc
{"type":"tool/result","data":{"turn":1,"step":1,"message":{
  "role":"tool",
  "source":{"kind":"tool","callId":"call_00_…"},
  "toolCallId":"call_00_…",          // ← 用它配对
  "content":[…], "isError":false, "id":"…"}}}
```
配对写：`tool/call` 记 `data.callId → time`；`tool/result` 查 `data.message?.toolCallId ?? data.message?.source?.callId`。

### 6.3c step 键必须带 turn
`step/start` / `step/end` 的 data 是 `{turn, step}`，**step 只在 turn 内唯一**。LLM 墙钟的 Map 键必须是 `` `${turn}:${step}` ``，否则跨 turn 串号。

### 6.4 需要折叠的事件类型（其余一律安全跳过，绝不抛）
`assistant/message`、`step/start`、`step/end`、`tool/call`、`tool/result`、`turn/start`、`turn/end`、`user/message`、`request/header`、`model/selection`、`session/title`。
实测还会出现（必须忽略不抛）：`assistant/attempt`、`request/context`、`session-log-deepseek/delivery-accepted`、`job/registered`、`job/settled`、`subagent/catalog`、`team/task`、`team/member`、`permission/preset`、`sandbox/mode`、`approval/policy`、`command/run`、`command/done`、`agent/inbox/spliced`、`system/message`、`developer/message`、`deliverables/presented`、`workspace/changes`、`session/end-seed`、`session/title-llm-request`。

### 6.5 会话标题
`session/title` 事件可提供会话标题（`sessions` 数组的 `title` 字段），缺失时回退为 `id` 前 8 位。

### 6.6 离线读日志的工具
`tools/zstd-frames.mjs` 导出 `scanZstdFrames` / `decodeSessionLog` / `readSessionArtifact`。
会话日志是**多帧拼接的 Zstandard 容器**，Node 的 `zlib.zstdDecompressSync` 只解第一帧（只拿到 207 字节 header 行），
必须先用 `scanZstdFrames` 扫帧边界再逐帧解压。运行时仍走 `ctx.sessionQuery`，此工具仅供离线自测。

## 7. 全量调用账本与账户账单（v2 增量，用户明确要求「token 用量要和开放平台对上」）

> 背景：会话日志只能看到 `assistant/message`，**漏掉** Auto review、会话标题、上下文压缩、
> 联网搜索等辅助模型调用（Auto review 的 README 明确写「每次工具调用前用当前 agent 的模型审一次…会消耗额外 token」）。
> 这些调用全部经过 Host 的 `llm/stream` waterfall，因此新增一个账本把它们完整计入。
> 实测：今天 00:00–00:35 本地日志 260 请求 / 27,053,363 token，平台账单 380 请求 / 29,945,558 token。

### 7.1 `lib/llm-ledger.js`（host-data 实现）

```js
export function createLlmLedger(ctx, options) -> {
  snapshot({ range }): LedgerView   // 契约 §7.3，同步返回
  flush(): Promise<void>            // 立即落盘
  start(): void
  dispose(): void                   // 幂等
}
```

- 拦截方式：`ctx.on('llm/stream', (callOptions, next) => wrapped)`。
  契约签名：`'llm/stream'(this, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>`。
  **必须**先 `const inner = next()`，返回 async generator：原样 yield 每个 chunk（不得改动、不得缓冲到最后再发），
  捕获 `{type:'usage'}` 的 `usage`，`finally` 里 `inner.return?.()`；**错误必须原样抛**，不得吞。
- 单次记录：`{ at, provider, model, purpose, sessionId, usage:{uncachedInputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens}, ok }`。
  `provider`/`model` 取 `callOptions.provider`/`callOptions.model`；
  `purpose` 取 `callOptions.purpose ?? 'chat'`（可能的取值：`'compaction'`、`'session-title'`、缺省即对话/审查）；
  `sessionId` 取 `callOptions.sessionId ?? null`。
- **持久化只保留小时聚合**，键 `hourKey|provider|model|purpose`，值
  `{ requests, uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`；保留最近 400 天。
  进程内另存最近 200 条原始调用供「实时」视图。
- 落盘：`options.cacheFile`（默认 `$DSH_HOME/usage-monitor/llm-ledger.json`），原子写（`.tmp` + rename），
  每 30s 或每 50 次记录 flush；`dispose()` 强制 flush。落盘失败只记 diag，**绝不抛**。
- `installedAt`：首次启动写入 `Date.now()`，是账本时间下界（之前的调用无法追回），必须出现在视图里。
- `ctx.get('llm')` 取**可选**服务；取不到 ⇒ `available:false`，不抛、不阻塞插件。

### 7.2 `lib/account.js`（host-data 实现）

```js
export function createAccountProbe(ctx, options) -> {
  refresh(): Promise<void>
  getView(): AccountView            // 契约 §7.4，同步读缓存
  startSignIn(baseOrigin): Promise<{ authorizeUrl, phase }>
  start(): void                     // 定时刷新，默认 60s
  dispose(): void                   // 幂等
}
```

- **必须用 `ctx.get('deepseekAccount')` 读可选服务，绝不能写进 `inject`**（老宿主没有该服务，写进 inject 会让整个插件永远不 apply）。
- 余额：`await account.getBalance({ version, locale, timezoneOffsetSeconds: -new Date().getTimezoneOffset()*60 })`
  → `{ status:'ready', value: AccountWallet[], bonusWallets: AccountWallet[] }`，
  `AccountWallet = { currency:'CNY'|'USD', balance:string }`。
  `total = 充值钱包同币种合计 + 赠金钱包同币种合计`（币种优先 CNY）。返回 `null` 或 `status!=='ready'` ⇒ 未登录/不可用。
- 账号识别：`await account.getState()` → `{ status:'signed-out'|'credential-stored', links:{ usageUrl, topUpUrl }, attempt }`。
- 登录：`await account.startSignIn(clientMeta, baseOrigin, 'web')`，
  `clientMeta = { version, locale, timezoneOffsetSeconds }`；返回的 `attempt.authorizeUrl` 即授权地址，
  `attempt.phase` 通常是 `'waiting-browser'`。
- 采样：每次 refresh 落 `{ at, total, recharge, bonus, currency }`，只保留**每天最后一条 + 最近 200 条**。
- 余额差法：`spend = 区间首条 total - 区间末条 total`；**检测到区间内余额上升即视为充值** ⇒ `hasTopUp:true` 且 spend 置 null。
- 落盘 `options.cacheFile`（默认 `$DSH_HOME/usage-monitor/account.json`），原子写。全部失败路径返回 `available:false` + `diag`，**绝不抛**。

### 7.3 `GET /usage-monitor/api/ledger?range=today|24h|7d|14d|30d|all&currency=CNY|USD`

```jsonc
{
  "generatedAt": 1700000000000,
  "available": true,
  "installedAt": 1700000000000,
  "range": { "key": "7d", "from": 0, "to": 0, "label": "近 7 天" },
  "currency": "CNY",
  "fxRate": 6.7146,
  "fx": {
    "baseCurrency": "CNY",
    "usdCnyRate": 6.7146,
    "source": "pboc-cfets",
    "sourceLabel": "中国人民银行授权·CFETS 人民币汇率中间价",
    "effectiveDate": "2026-11-02",
    "fetchedAt": 1700000000000,
    "stale": false
  },
  "totals": {
    "requests": 1234,
    "uncachedInputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "outputTokens": 0,
    "totalTokens": 0, "cacheHitRate": 0.0,
    "cost": 0.0, "costCNY": 0.0, "costUSD": 0.0     // 三字段口径同 §2.1；CNY 权威
  },
  "byPurpose": [ { "purpose": "chat", "requests": 0, "totalTokens": 0, "cost": 0, "costCNY": 0, "costUSD": 0 } ],
  "byModel":   [ { "provider": "deepseek-account", "model": "deepseek-flash", "requests": 0, "totalTokens": 0, "cost": 0, "costCNY": 0, "costUSD": 0 } ],
  "byHour":    [ { "hourKey": 494000, "time": 0, "requests": 0, "totalTokens": 0, "cost": 0, "costCNY": 0, "costUSD": 0 } ],
  "recent":    [ { "at": 0, "provider": "", "model": "", "purpose": "chat", "totalTokens": 0, "cost": 0, "costCNY": 0, "costUSD": 0 } ],
  "missing": 0,
  "diag": ""
}
```

`range=today` 语义同 §2.1（本地时区当天 00:00 起，按小时出桶）；`currency` 缺省 `CNY`。

`byPurpose.purpose` 取值集合固定为 `'chat' | 'compaction' | 'session-title' | 'other'`（`callOptions.purpose` 原值，未知值归一成 `'other'`）。

### 7.4 `GET /usage-monitor/api/account`

```jsonc
{
  "generatedAt": 1700000000000,
  "available": true,
  "signedIn": true,
  "currency": "CNY",
  "balance": { "total": 100.00, "recharge": 80.00, "bonus": 20.00 },
  "sampledAt": 1700000000000,
  "usageUrl": "https://…",
  "topUpUrl": "https://…",
  "spend": { "today": 3.02, "yesterday": null, "last7d": null, "last30d": null },
  "spendSource": "wallet-ledger",     // 'wallet-ledger' | 'balance-sampling'
  "spendComplete": { "today": true, "yesterday": true, "last7d": true, "last30d": false },
  "hasTopUp": false,
  "diag": ""
}
```

- `spendSource`：`spend` 四窗口来自哪里。`wallet-ledger` = §7.8 的余额账本（本插件自建为主、可选小鲸鱼文件回填；安装前的天也能算，和平台账单最接近）；`balance-sampling` = 本插件自己的余额采样。
- `spendComplete`：每个窗口的金额是否覆盖完整窗口；`false` 表示只是下界（例：插件今天 00:40 才安装，今日 00:00–00:40 没有采样）。
- 历史账本**可用且新鲜**（源文件 10 分钟内更新过）时，`spend` 与 `spendComplete` 优先用账本（`wallet-ledger`）；账本缺失/过期/格式变化时退回自采样，并在 `diag` 里用中文说明原因。**绝不因为账本而 500 或抛错**。

### 7.5 `POST /usage-monitor/api/account/login`

响应 `{ "authorizeUrl": "https://…", "phase": "waiting-browser" }`；失败 `500 { error, diag }`。
`baseOrigin = (req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host`。
前端拿到 `authorizeUrl` 后 `window.open` 打开；登录完成后轮询 `/account`，看到 `signedIn:true` 即刷新。

### 7.6 展示口径（Client 必须这样做，**不得相加**）

- **会话口径**：`overview` —— 覆盖安装前的全部历史，只含会话内 `assistant/message`，不含辅助调用。
- **全量调用口径**：`ledger` —— 含辅助调用与全部模型调用，但只能从 `installedAt` 起。
- **平台账单口径**：`account.spend` —— 余额差法，唯一与开放平台严格一致的消费数字。
- 三块并列，各自标注口径与时间下界；`ledger` 与 `account.spend` 的百分比偏差作为「对账」指标显示。

### 7.7 `index.js` 装配契约（Lead 已写好 v2，两侧按此对齐）

```js
export const inject = ['webServer', 'sessionQuery', 'sessions']   // llm / deepseekAccount 不进 inject

export function apply(ctx, config) {
  const settings = config ?? {}
  const extras = { ledger: null, account: null, billHistory: null, fxRate: null }

  extras.fxRate  = createFxRate(ctx, { cacheFile: settings.fxFile, refreshIntervalMs: settings.fxRefreshIntervalMs, configRate: settings.fx?.USDCNY })
  const collector = createCollector(ctx, settings, { fxRate: extras.fxRate })   // 可能抛，单独兜住
  extras.ledger  = createLlmLedger(ctx, { cacheFile: settings.ledgerFile, sampleIntervalMs: settings.sampleIntervalMs, usdCnyRate: settings.fx?.USDCNY, fxRate: extras.fxRate })
  extras.billHistory = createBillHistory({ file: settings.billHistoryFile, cacheFile: settings.billHistoryCacheFile })
  extras.account = createAccountProbe(ctx, { cacheFile: settings.accountFile, refreshIntervalMs: settings.accountRefreshIntervalMs, billHistory: extras.billHistory })
  registerUsageRoutes(ctx, collector, disposers, extras)                  // ← v2 起第 4 个参数
  extras.fxRate?.start(); collector?.start(); extras.ledger?.start(); extras.account?.start()
  ctx.effect(() => () => { /* 逐个 disposer，幂等 */ })
}
```

因此：
- `registerUsageRoutes(ctx, collector, disposers, extras)`，`extras = { ledger, account, billHistory, fxRate }`，**每个字段都可能是 null**
  （模块构造失败时 index.js 会把对应字段置 null 而不是让插件失效）。路由遇到 null 时返回 `available:false` + `diag`，不得 500。
- `createLlmLedger(ctx, { cacheFile, sampleIntervalMs, usdCnyRate, fxRate })`、`createAccountProbe(ctx, { cacheFile, refreshIntervalMs, billHistory })`
  与 `createBillHistory({ file, cacheFile })` 的 `cacheFile` 可能是 `undefined`，必须自己在内部按 §7.1/§7.2/§7.8 的默认路径兜底。
- **五个工厂函数**（fx / collect / ledger / account / bill-history）**不得在构造期做 IO、不得抛人类可见错误**；`start()` 才启动定时器；
  `dispose()` 必须幂等且必须 flush 未落盘数据。
- `lib/client.js` 会在 `/ledger`、`/account`、`/bill-history`、`/fx` 不存在或 5xx 时降级显示，不会白屏。

### 7.8 余额账本（v6，`lib/bill-history.js` + `lib/account.js` + `GET /usage-monitor/api/bill-history`）

**目的**：`ledger` 只能从 `installedAt` 起算，`account.spend` 只能用本插件安装后的余额采样——两者都补不上安装前的空档。
v3 的实现只读本机另一个插件（dsh-whale-widget）残留的 `$DSH_HOME/.dshw-usage.json`，属于**硬依赖**；
v6 起改为**本插件自建为主**：`lib/account.js` 本来就在周期调用 `deepseekAccount.getBalance()`，
把每次成功采样的余额升级为按天复式账本并持久化，whale 文件降级为「可选的安装前历史回填」。
**不再依赖任何其他插件**：没有 whale 文件也能从安装起提供账本。

**来源 1：native 自建（主）** — `lib/account.js` 的 `createAccountProbe(...).dailyLedger()`

- 每次成功取余额（`/account` 刷新周期，默认 60s）追加一条观测；按**北京时区日历日**累计：
  `row = { day, firstAt, lastAt, openingUnits, lastUnits, debitUnits, creditUnits }`，`SCALE = 1e8`（1 CNY = 1e8 units）。
- `delta = lastUnits - units`：`delta > 0` → `debitUnits += delta`（消费）；`delta < 0` → `creditUnits -= delta`（充值）；
  随后 `lastUnits = units`、`lastAt = at`。乱序/重复观测（`at <= lastAt`）直接忽略。
- 跨零点：新一天的 `opening` 继承上一天的 `lastUnits`（没有更早观测则取当前单位）。
- 持久化在 `account.json`（`version: 2` 的 `days`）；加载旧版（`version: 1`）时**从已有 `samples` 按时间顺序回放生成 `days`**，
  因此升级当天立刻拥有账本数据。保留 400 天。
- `complete` 判据（与 whale 原文一致）：观测起点距当日 00:00 超过 **10 分钟** ⇒ 缺前半段；
  已过去的日期最后一次观测距次日 00:00 超过 10 分钟 ⇒ 缺后半段；任一缺口即 `complete:false`。今天只看起点。
- 返回：`{ source:'usage-monitor', currency, scopeTag:'account', days:[{day,cost,debit,credit,opening,closing,firstAt,lastAt,complete}] }`。
  **既有 `samples` / `spend` / `spendCoverage` / `hasTopUp` 语义完全不变。**

**来源 2：whale 回填（可选，严格只读，绝不写/删/改）**：`$DSH_HOME/.dshw-usage.json`

```jsonc
{
  "accounting": {
    "version": 1,
    "active": "<key>-CNY",
    "books": {
      "<key>-CNY": {
        "currency": "CNY",
        "days": {
          "2026-10-25": {
            "day": "2026-10-25",
            "firstAt": 1792905514207, "lastAt": 1792943999716,
            "openingUnits": 3140527900, "lastUnits": 1399763000,
            "debitUnits": 1740764900, "creditUnits": 0,
            "revision": 0, "correction": null
          }
        }
      }
    }
  }
}
```

- **单位：1 CNY = 1e8 units**（实测校准：`1740764900 / 1e8 = 17.407649`，与该文件的 `history["2026-10-25"]` 完全一致）。
- 当日消费 `cost = debitUnits / 1e8`；当日充值 `credit = creditUnits / 1e8`；`opening/closing` 仅作展示参考。
- `complete` 语义（**whale 回填天专用**，native 天用 10 分钟判据）：`firstAt > 0` 且 `firstAt <= 本地当天 00:00 + 90s`。**只覆盖半天/插件安装当天的数据必须标 `complete:false`**，UI 需把它显示为「≥」下界而非精确值。
- 币种：优先 `books` 里 `currency === 'CNY'` 的账本，否则取第一个（响应 `currency` 跟随账本）。
- 兼容与降级：
  - `accounting` 缺失但顶层有 `history`（日金额，单位已是 CNY）时降级使用，`complete` 一律 `false`，`diag` 说明原因；
  - **任何** 读不到 / JSON 损坏 / `accounting.version !== 1` / 没有可用按天记录 ⇒ `available:false` + 中文 `diag`，**绝不抛、绝不让插件失效**；
  - 解析结果缓存到 `$DSH_HOME/usage-monitor/bill-history.json`（原子写），用源文件 mtime + size 判断是否重读；`stats().sourceReads` 可验证「源文件没变就不重读」。
  - 账本超过 **10 分钟** 未更新视为过期：`/bill-history` 仍返回最近一次解析结果（`freshness.ageMs` 标出），但 `/account` 的 `spend` 退回自采样。

**合并规则（`lib/bill-history.js`，v6.1 起为「双源日观测级合并」）**

> 观测是唯一原语，`days` 只是它的聚合。两个来源对同一天各自只看到一段窗口
> （native 可能从更晚开始但结束更近；whale 可能从零点前就开始但结束更早），
> **整行二选一必然丢掉一端数据**（例：取 native 今日 debit 会比真实少一部分）。

- **单来源日期**：直接透传，不走合并。native 天 `origin:'monitor'`、whale 天 `origin:'whale'`。
- **双来源都有的日期**：把两行还原成观测点后统一回放：
  ```
  obs = [ {at: native.firstAt, balance: native.opening},
          {at: native.lastAt,  balance: native.closing},
          {at: whale.firstAt,  balance: whale.opening},
          {at: whale.lastAt,   balance: whale.closing} ]
  ```
  1. 按 `at` 升序；`at` 完全相同的只保留一条（优先 native 的 balance）。
  2. 用与 `lib/account.js` `observeLedger()` 相同的算法回放：`delta = lastUnits - units`，
     `delta > 0 → debit += delta`（消费），`delta < 0 → credit -= delta`（充值），再更新 `lastUnits`。
  3. 结果：`opening` = 最早观测（通常是 whale 的零点窗口）、`closing` = 最新观测（通常是 native 的当前值）、
     `debit` = 中间所有净下降之和（充值不冲减消费），`firstAt/lastAt` 取合并后端点，
     `complete` 用合并后的 `firstAt/lastAt` 按 10 分钟判据重算，`origin:'monitor+whale'`。
- 顶层 `source`：全 native ⇒ `'monitor'`；全 whale ⇒ `'whale'`；存在合成日或混合来源 ⇒ `'monitor+whale'`。
  同时输出 `legacySource: 'wallet-ledger'` 兼容旧客户端。
- `available`：任一来源有数据即 `true`；都没有 ⇒ `false` + 中文 `diag`（响应仍 200）。
- 时间口径：native/whale 的「日」都是北京日历日；`totals.7d/14d/30d` 用「含今天的自然日窗口」现算（与 `/account` 一致），`all` = 合并后全部天数。
- 新鲜度：native 随采样实时更新，所以只要它贡献了日期就视为新鲜；纯 whale 时看源文件 mtime（沿用 10 分钟过期规则）。
- 设计取舍：native 的 `complete` 用 10 分钟判据；whale 天沿用文件里已有的 `complete`（`firstAt` 距 00:00 +90s 的旧判据）；合成天用合并后的端点重算。
- whale 文件缺失/损坏只影响回填，**绝不影响 native 账本**，也绝不抛。

**接口**：`defaultBillHistoryFile()`、`defaultBillHistoryCacheFile()`、
`createBillHistory(options) -> { load(), snapshot({range?}), windows(now?), dispose(), stats() }`。
`options = { file?, cacheFile?, native? }`，`native` 是可选函数（返回 `dailyLedger()` 结果或 `null`）；
`range` 取值 `'7d' | '14d' | '30d' | 'all'`（缺省/非法回落 `'30d'`）。

**`GET /usage-monitor/api/bill-history?range=7d|14d|30d|all`**

```jsonc
{
  "generatedAt": 1700000000000,
  "available": true,
  "source": "monitor+whale",         // 'monitor' | 'whale' | 'monitor+whale'
  "legacySource": "wallet-ledger",   // 旧客户端兼容字段（v6 起用 source）
  "currency": "CNY",
  "range": { "key": "30d", "label": "近 30 天" },
  "days": [
    { "day": "2026-10-25", "cost": 17.407649, "debit": 17.407649, "credit": 0,
      "opening": 31.405279, "closing": 13.99763,
      "firstAt": 1792905514207, "lastAt": 1792943999716, "complete": true,
      "origin": "whale" },                                        // 'monitor' | 'whale' | 'monitor+whale'
    { "day": "2026-11-03", "cost": 25.608194, "debit": 25.608194, "credit": 0,
      "opening": 74.194522, "closing": 48.586328,
      "firstAt": 1793606450000, "lastAt": 1793643600000, "complete": true,
      "origin": "monitor+whale" }                                 // 双源日观测级合并
  ],
  "since": "2026-10-24",
  "until": "2026-11-03",
  "totals": { "7d": { "cost": 0 }, "14d": { "cost": 0 }, "30d": { "cost": 0 }, "all": { "cost": 0 } },
  "freshness": { "fileMtime": 1793000000000, "ageMs": 1234, "nativeDays": 3, "whaleDays": 10 },
  "diag": ""
}
```

- `totals.7d/14d/30d` 按「含今天的自然日窗口」求和（与 `/account` 的窗口一致），`all` = 账本全部天数合计；金额均为 CNY。
- 模块不可用（extras 为 null、文件缺失、格式变化）时仍返回 **200** + 上述全字段、`available:false`、`days:[]`、`totals` 四窗口 0、`diag` 写原因。**绝不得 500**。
- 与其它口径的关系：`overview` = 会话日志（最全历史，但漏辅助调用）；`ledger` = 真实模型调用（自安装起）；`bill-history` / `account.spend` = 平台账单口径（余额差 / 账本日金额）。UI 并列展示，**不得相加**。

### 7.9 实时汇率（v4，`lib/fx.js` + `GET /usage-monitor/api/fx`）

**目的**：用户要求「汇率实时符合央行发布的汇率」。v3 之前 `fx.USDCNY` 只是 `cordis.patch.yml` 里写死的 7.1；
v4 起 Host 运行时抓取**央行授权发布的人民币汇率中间价**（中国外汇交易中心 CFETS），失败链逐级降级，绝不阻塞。

**数据源（优先级从高到低，均有实测）**

| # | source | URL / 取法 | 口径 |
|---|---|---|---|
| 1 | `pboc-cfets` | `https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/fx/ccpr.json`；`records.find(r => r.vrtEName === 'USD/CNY').price`，生效日取 `data.lastDate` 的日期部分 | 央行授权·CFETS 中间价（首选） |
| 2 | `pboc-cfets-history` | `https://www.chinamoney.com.cn/ags/ms/cm-u-bk-ccpr/CcprHisNew?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&currency=USD/CNY&pageNum=1&pageSize=10`；`records[0].values[0]` + `records[0].date` | 同上，最近交易日历史接口 |
| 3 | `market` | `https://api.exchangerate-api.com/v4/latest/USD`；`rates.CNY` | 第三方市场汇率，**非央行口径，UI 必须如实标注** |
| 4 | `config` | `config.fx.USDCNY`（默认 7.1） | 最终兜底 / 离线值 |

- 请求需带浏览器 UA（该站点无 UA 可能拒绝），单次超时默认 8s；任一源失败只记中文诊断并继续下一级，**绝不抛**。
- 2026-11-02 实测主源返回：`USD/CNY = 6.7146`，`data.lastDate = "2026-11-02 9:15"` → `effectiveDate = "2026-11-02"`。

**`FxRateView`**（`getRate()` 返回值，同步、无 IO、绝不抛）

```jsonc
{
  "rate": 6.7146,                       // 1 USD = rate CNY（永远 > 0）
  "currency": "CNY",
  "quote": "USD",
  "source": "pboc-cfets",               // pboc-cfets | pboc-cfets-history | market | config
  "sourceLabel": "中国人民银行授权·CFETS 人民币汇率中间价",   // 给 UI 直显，不得改写口径
  "effectiveDate": "2026-11-02",        // 中间价生效日，拿不到为 null
  "fetchedAt": 1700000000000,           // 最近成功抓取时间；0 = 从未
  "stale": false,                       // true = 旧值/兜底值
  "diag": ""                            // 人话说明（中文）
}
```

**刷新策略**
- 构造期**零 IO、零请求**；`start()` 才：同步读缓存 → 24h 内有效则先用于 `getRate()`，再后台 `refresh()`；缺失/过期则等 refresh。
- 定时 `refresh`，周期 `fxRefreshIntervalMs`（默认 30 分钟），定时器必须 `unref()`；`refresh()` 单飞（single-flight）。
- 抓取失败保留上一次值 + `stale:true` + 中文 `diag`；全部失败且无旧值时回落到 `config` 兜底值（`source:'config'`、`stale:true`）。
- 缓存：`options.cacheFile`（默认 `$DSH_HOME/usage-monitor/fx.json`），结构 `{ version:1, rate, effectiveDate, fetchedAt, source }`，原子写（同目录 `.tmp` → rename）；版本不符/损坏直接忽略。

**成本口径硬约束（不得违反）**
- **CNY 仍是唯一权威基准**：`lib/fold.js` 的 `BUILTIN_PRICING` 是按汇率 7.1 快照的 CNY 价表，**不得**用实时汇率重算历史成本（否则历史金额会随汇率漂移）。
- 实时汇率只用于两处：`costUSD = costCNY / fxRate` 的派生展示，以及 `fx` 元数据块（`overview` 与 `ledger`）。

**`GET /usage-monitor/api/fx`**（第 7 条 exact 路由，`Cache-Control: no-store`）

```jsonc
{
  "generatedAt": 1700000000000,
  "available": true,                    // false = 模块不可用/尚无有效值（仍返回 200）
  "rate": 6.7146,
  "currency": "CNY",
  "quote": "USD",
  "source": "pboc-cfets",
  "sourceLabel": "中国人民银行授权·CFETS 人民币汇率中间价",
  "effectiveDate": "2026-11-02",
  "fetchedAt": 1700000000000,
  "stale": false,
  "diag": ""
}
```

- `extras.fxRate` 为 null、`getRate()` 抛错或尚未返回有效值时：**一律 200** + 全字段 + `available:false` + `rate` 取配置兜底值 + `source:'config'` + `diag` 写原因。**绝不得 500**。
- 非 `GET` → `405 { error: 'method not allowed' }`。

