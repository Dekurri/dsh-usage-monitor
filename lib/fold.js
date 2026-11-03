/**
 * dsh-usage-monitor — 纯函数事件折叠层。
 *
 * 本模块没有任何 I/O，也不依赖 Host 运行时：它把 `SessionEvent`（由
 * `ctx.sessionQuery` 提供）与 `SessionHeader` 折叠成一个纯数据统计对象，
 * 让实时采集器（lib/collect.js）与离线自测（tools/scan-real.mjs）共用同一套口径。
 *
 * ── 真实日志口径（2026-11 对 75 个 v4 日志实测确认）────────────────────────
 * - `event.time`、`stream[].time0`、`stream[].time` 都是 epoch 毫秒。
 * - `assistant/message.data.usage`（TokenUsage）里的 `inputTokens` 是**未缓存输入**
 *   （uncached input），不是总输入。总输入 = inputTokens + cacheReadTokens + cacheWriteTokens。
 *   实测恒等式：totalTokens === inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens。
 * - `event.data.stream` 是 AssistantStreamRecord 数组，真实日志里**两种形状都出现**，
 *   必须都处理：
 *     1. `{ type: 'chunk', time, chunk }`：chunk.type 为 text-delta / reasoning-delta /
 *        tool-call-delta / usage / block-start / block-end / finish 等；
 *     2. `{ type: 'text-chunks' | 'reasoning-chunks' | 'tool-call-chunks', time0, index,
 *        dt: number[], texts | args, id?, name? }`：同一 block 的增量被聚合成 run。
 *   TTFT 取「首个非空 delta」的时间（与 dsh-session-stats 的
 *   `assistantStreamFirstTokenTime` 一致），两种形状都能算。
 * - `turn/end.data.reason.kind`：completed / aborted / blocked / error / max-tokens /
 *   interrupted / forked。
 *
 * 折叠时只关心 assistant/message、assistant/attempt、step/start、step/end、
 * tool/call、tool/result、turn/start、turn/end、session/title、llm/retry-started；
 * 其余事件类型（日志里有几十种）一律静默跳过，**绝不抛异常**。
 *
 * 成本随 token 采样一起结算：按**事件时间**选 peak/off-peak 单价（priceFor + costOf），
 * 周末与中国法定节假日（北京日历日）全天按 off-peak 结算；
 * 金额以 **CNY（人民币）为权威基准**（见 PRICING_BASE_CURRENCY / BUILTIN_PRICING）；
 * USD 只是由 collect / ledger 用汇率派生的展示值。
 */

/** 一小时毫秒数。 */
export const HOUR_MS = 60 * 60 * 1000

// ─────────────────────────────────────────────────────────────────────────────
// 价格表（CNY / 1M tokens）——人民币是权威基准，美元只是派生展示
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 价格表基准币种（v5）：**CNY 是唯一权威基准**，USD 仅用于派生展示。
 *
 * 内置表数值直接取自官方定价页的**人民币价目表**（CNY / 1M tokens），不再经美元换算；
 * `settings.fx.USDCNY`（配合实时中间价）只影响 **USD 展示值** 的换算，不影响 CNY 权威金额。
 */
export const PRICING_BASE_CURRENCY = 'CNY'

/**
 * 内置价格表：**CNY / 1M tokens**（官方人民币原值，权威基准），键是模型 id。
 *
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing （官方中文页直接给出人民币价目表，
 * 2026-11-03 抓取；**估算值，可能过时**）。官方脚注：「空闲时段价格为高峰时段价格的一半。北京时间
 * 周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00 为高峰时段；其余时段，包括周末及中国
 * 法定节假日全天均为空闲时段。」换算成 UTC 高峰窗即 01:00–04:00 / 06:00–10:00。
 * 表内每项是 `{ peak: {…}, offPeak: {…} }`；成本按**事件时间**落在哪一档结算
 * （见 `isPeakHour` / `priceFor(model, pricing, timeMs, holidays)`），而不是按「当前时间」。
 *
 * `cacheWrite` 官方未单列，按「cache miss（未缓存输入）」同价计。
 * `config.pricing` 若被配置，同样**视为 CNY 表**（不再做任何汇率换算）。
 */
export const BUILTIN_PRICING = Object.freeze({
  // DeepSeek-V4.1-Flash-1017：高峰 cache hit ¥0.04 / cache miss ¥2 / output ¥8；谷价减半
  'deepseek-flash': Object.freeze({
    peak: Object.freeze({ input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }),
    offPeak: Object.freeze({ input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }),
  }),
  // DeepSeek-V4-Pro-0813：高峰 cache hit ¥0.30 / cache miss ¥9 / output ¥27；谷价减半
  'deepseek-v4-pro': Object.freeze({
    peak: Object.freeze({ input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 }),
    offPeak: Object.freeze({ input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 }),
  }),
  // 已退役别名：官方说明仍按 Flash 价计费（DeepSeek-V4.1-Flash-1017 承接）
  'deepseek-v4-flash': Object.freeze({
    peak: Object.freeze({ input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }),
    offPeak: Object.freeze({ input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }),
  }),
  // 已退役别名（视觉实验版）：同样按 Flash 价计费
  'deepseek-v4-flash-vision-exp': Object.freeze({
    peak: Object.freeze({ input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }),
    offPeak: Object.freeze({ input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }),
  }),
  // 旧版模型（deepseek-chat / deepseek-reasoner）：官方定价页已不再列出，
  // 仅保留历史量级参考；⚠️ 未验证、已退役，旧价是否分峰谷未见官方说明 → 按减半假设估算。
  'deepseek-chat': Object.freeze({
    peak: Object.freeze({ input: 1.988, cacheRead: 0.1988, cacheWrite: 1.988, output: 2.982 }),
    offPeak: Object.freeze({ input: 0.994, cacheRead: 0.0994, cacheWrite: 0.994, output: 1.491 }),
  }),
  'deepseek-reasoner': Object.freeze({
    peak: Object.freeze({ input: 1.988, cacheRead: 0.1988, cacheWrite: 1.988, output: 2.982 }),
    offPeak: Object.freeze({ input: 0.994, cacheRead: 0.0994, cacheWrite: 0.994, output: 1.491 }),
  }),
})

/** 价格表来源（写进 overview.pricing.source）。 */
export const PRICING_SOURCE =
  'builtin: api-docs.deepseek.com/zh-cn/quick_start/pricing (fetched 2026-11-03; official CNY list price; peak/off-peak, off-peak = half of peak; weekends & Chinese public holidays = off-peak all day; estimate, may be stale)'

/** 价格表更新时间（epoch ms；写进 overview.pricing.updatedAt）。 */
export const PRICING_UPDATED_AT = Date.UTC(2026, 10, 3)

/**
 * peak 时段（UTC 小时，左闭右开）：01:00–04:00 与 06:00–10:00，周一至周五。
 * 官方中文定价页脚注原文：「空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）
 * 9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。」
 * 北京 = UTC+8（无夏令时），故高峰窗换算成 UTC 小时即上面的区间；高峰窗内 UTC 星期与北京星期同一天，
 * 因此按 UTC 星期判断工作日等价。
 * 官方定价页：https://api-docs.deepseek.com/zh-cn/quick_start/pricing （2026-11-03 实测）
 */
export const PEAK_HOURS_UTC = Object.freeze([[1, 4], [6, 10]])

/** peak 只发生在工作日（UTC 周一至周五）。 */
export const PEAK_WEEKDAYS = 'Mon-Fri'

/**
 * 中国法定节假日（北京日历日，'YYYY-MM-DD'）：2025–2026 共 61 天。
 *
 * 数据来源：github.com/NateScarlet/holiday-cn（master 分支 2025.json / 2026.json 里 `isOffDay === true`
 * 的日期），2026-11-03 抓取；只含放假日期，不含调休上班日。调休上班的周六/周日按官方规则仍属周末，
 * 全天 off-peak，无需特殊处理。2027 年起官方放假安排尚未发布，不在内置表内；可用
 * `config.pricingHolidays` 追加，未覆盖年份会按 peak 计（可能高估，最多 2 倍）。
 */
export const CN_HOLIDAY_DAYS = Object.freeze([
  '2025-01-01',
  '2025-01-28',
  '2025-01-29',
  '2025-01-30',
  '2025-01-31',
  '2025-02-01',
  '2025-02-02',
  '2025-02-03',
  '2025-02-04',
  '2025-04-04',
  '2025-04-05',
  '2025-04-06',
  '2025-05-01',
  '2025-05-02',
  '2025-05-03',
  '2025-05-04',
  '2025-05-05',
  '2025-05-31',
  '2025-06-01',
  '2025-06-02',
  '2025-10-01',
  '2025-10-02',
  '2025-10-03',
  '2025-10-04',
  '2025-10-05',
  '2025-10-06',
  '2025-10-07',
  '2025-10-08',
  '2026-01-01',
  '2026-01-02',
  '2026-01-03',
  '2026-02-15',
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-02-19',
  '2026-02-20',
  '2026-02-21',
  '2026-02-22',
  '2026-02-23',
  '2026-04-04',
  '2026-04-05',
  '2026-04-06',
  '2026-05-01',
  '2026-05-02',
  '2026-05-03',
  '2026-05-04',
  '2026-05-05',
  '2026-06-19',
  '2026-06-20',
  '2026-06-21',
  '2026-09-25',
  '2026-09-26',
  '2026-09-27',
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
])

/** 内置节假日数据覆盖的年份。 */
export const CN_HOLIDAY_YEARS = Object.freeze([2025, 2026])

/** 节假日数据来源（写进 overview.pricing.holidaySource）。 */
export const PRICING_HOLIDAY_SOURCE =
  'builtin: github.com/NateScarlet/holiday-cn (2025.json/2026.json, isOffDay=true; fetched 2026-11-03)'

/** 'YYYY-MM-DD' 形态校验（节假日配置项过滤用）。 */
const HOLIDAY_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 北京时间相对 UTC 的固定偏移：UTC+8，无夏令时。 */
const BEIJING_OFFSET_MS = 8 * HOUR_MS

/**
 * 把 epoch ms 换成**北京日历日**键 'YYYY-MM-DD'。
 * 用 UTC 取值器 + 固定 +8h 偏移，保证不依赖宿主时区/夏令时（确定性）。
 * @param {number} timeMs
 * @returns {string | null}
 */
function beijingDayKey(timeMs) {
  const time = finiteNumber(timeMs)
  if (time === null) return null
  const date = new Date(time + BEIJING_OFFSET_MS)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return date.getUTCFullYear() + '-' + month + '-' + day
}

/**
 * 把「内置节假日 + 追加项」合成一个 Set（追加项里非 'YYYY-MM-DD' 的脏值忽略）。
 * @param {string[] | null | undefined} extra 追加的节假日（config.pricingHolidays）
 * @returns {Set<string>}
 */
export function holidaySetOf(extra) {
  const set = new Set(CN_HOLIDAY_DAYS)
  if (Array.isArray(extra)) {
    for (const item of extra) {
      if (typeof item === 'string' && HOLIDAY_DAY_PATTERN.test(item)) set.add(item)
    }
  }
  return set
}

/** 内置节假日集合（isPeakHour / isChinaHoliday 缺省用）。 */
const BUILTIN_HOLIDAY_SET = holidaySetOf(null)

/**
 * 归一化节假日参数：未传 → 内置表；Set → 直接用；数组 → 转 Set（脏值忽略）。
 * @param {Set<string> | string[] | null | undefined} holidays
 * @returns {Set<string>}
 */
function resolveHolidaySet(holidays) {
  if (holidays instanceof Set) return holidays
  if (Array.isArray(holidays)) return holidaySetOf(holidays)
  return BUILTIN_HOLIDAY_SET
}

/**
 * 某个时间点是否落在**中国法定节假日**（按北京日历日）。
 * @param {number} timeMs 事件发生时间（epoch ms）
 * @param {Set<string> | string[]} [holidays] 节假日集合；缺省用内置 2025/2026 表
 * @returns {boolean}
 */
export function isChinaHoliday(timeMs, holidays) {
  const key = beijingDayKey(timeMs)
  if (key === null) return false
  return resolveHolidaySet(holidays).has(key)
}

/**
 * 判断某个时间点是否在 peak 时段。
 *
 * 规则（官方定价页脚注）：北京时间周一至周五（**不含中国法定节假日**）9:00–12:00、
 * 14:00–18:00 为高峰；其余时段（含周末、中国法定节假日全天）为 off-peak（价格减半）。
 * 已知边界：内置节假日表只覆盖 2025/2026；未知年份的节假日会按 peak 计（可能高估），
 * 可用 `config.pricingHolidays` 追加。
 * @param {number} timeMs 事件发生时间（epoch ms）
 * @param {Set<string> | string[]} [holidays] 节假日集合；缺省用内置 2025/2026 表
 * @returns {boolean}
 */
export function isPeakHour(timeMs, holidays) {
  const time = finiteNumber(timeMs)
  if (time === null) return false
  if (isChinaHoliday(time, holidays)) return false // 法定节假日全天 off-peak
  const date = new Date(time)
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false // 周六 / 周日全天 off-peak
  const hour = date.getUTCHours()
  return PEAK_HOURS_UTC.some(([from, to]) => hour >= from && hour < to)
}

/** 模型 id 别名（config.pricing 若用别名覆盖，也认）。 */
const MODEL_ALIASES = Object.freeze({
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
})

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_OBJECT = Object.freeze({})

/** @returns {number | null} 有限数字，否则 null。 */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** @returns {number} 有限非负数字，否则 0（对外数字的统一兜底，避免 NaN 漏到 UI）。 */
function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** @returns {string | null} 非空字符串，否则 null。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 事件发生时间所属的小时桶键（epoch ms，UTC 小时对齐）。
 * @param {number} time
 * @returns {number | null}
 */
export function hourKeyOf(time) {
  const t = finiteNumber(time)
  return t === null ? null : Math.floor(t / HOUR_MS) * HOUR_MS
}

/**
 * 模型在内部 Map 里的复合键（provider 区分同名模型）。
 * @param {string} provider
 * @param {string} model
 * @returns {string}
 */
export function modelKeyOf(provider, model) {
  return `${provider}\u0000${model}`
}

/** assistant/attempt 还没有可用的 message.source 时使用的模型占位键。 */
const UNKNOWN_MODEL_KEY = modelKeyOf('unknown', 'unknown')

/**
 * 把内部复合键拆回 { provider, model }。
 * @param {string} key
 * @returns {{ provider: string, model: string }}
 */
export function splitModelKey(key) {
  const index = typeof key === 'string' ? key.indexOf('\u0000') : -1
  if (index < 0) return { provider: 'unknown', model: typeof key === 'string' ? key : 'unknown' }
  return { provider: key.slice(0, index) || 'unknown', model: key.slice(index + 1) || 'unknown' }
}

/** @returns {TokenBucket} 全零 token 桶（costCNY 是随 token 一起结算的估算成本，CNY）。 */
export function emptyTokenBucket() {
  return {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costCNY: 0,
  }
}

/**
 * 总 token 数 = 未缓存输入 + 缓存读 + 缓存写 + 输出（reasoning 已含在 output 内）。
 * @param {{ uncachedInputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, outputTokens?: number }} tokens
 * @returns {number}
 */
export function sumTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return 0
  return (
    nonNegativeNumber(tokens.uncachedInputTokens) +
    nonNegativeNumber(tokens.cacheReadTokens) +
    nonNegativeNumber(tokens.cacheWriteTokens) +
    nonNegativeNumber(tokens.outputTokens)
  )
}

/**
 * 缓存命中率 = cacheRead / (uncachedInput + cacheRead + cacheWrite)，分母为 0 时返回 0。
 * 契约注释写的是 cacheRead / (cacheRead + uncachedInputTokens)，实测 cacheWriteTokens
 * 恒为 0，两者数值相同；这里把 cacheWrite 也计入分母（与 Lead 实测口径一致）。
 * @param {{ uncachedInputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} tokens
 * @returns {number} 0..1
 */
export function cacheHitRateOf(tokens) {
  if (!tokens || typeof tokens !== 'object') return 0
  const cacheReadTokens = nonNegativeNumber(tokens.cacheReadTokens)
  const uncachedInputTokens = nonNegativeNumber(tokens.uncachedInputTokens)
  const cacheWriteTokens = nonNegativeNumber(tokens.cacheWriteTokens)
  const denominator = cacheReadTokens + uncachedInputTokens + cacheWriteTokens
  if (denominator <= 0) return 0
  return cacheReadTokens / denominator
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn / step 追踪状态
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 单个会话的 turn/step 追踪状态。折叠逻辑与 dsh-session-stats 的 projection 一致：
 * step/start 开一个 open step，assistant/message 收尾并结算 llm/ttft/decode 墙钟。
 * @returns {TurnState}
 */
export function newTurnState() {
  return {
    /** @type {{ turn: number | null, step: number | null, startTime: number | null, firstTokenTime: number | null } | null} */
    openStep: null,
    /** @type {Map<string, number>} callId → 派发时间 */
    pendingCalls: new Map(),
    /** @type {number | null} 已计入 turns 的最后一个 turn（step/end 只在新 turn 首次出现时 +1） */
    lastTurn: null,
    /**
     * 最近一次 token 采样，语义与 `dsh-token-meter` 的 tokenUsageProjection 完全一致：
     * 同一个 (turn, step) 的下一次采样会**替换**它（addReplacing），相同数值不重复累加；
     * `llm/retry-started` 只在 (turn, step) 匹配时清空引用——它**不撤回**已计入的用量
     * （失败的重试本身也消耗 token，这是 DSH 权威口径）。
     * @type {TokenSampleContext | null}
     */
    tokenSample: null,
    /**
     * 最近一次 assistant/message 的模型：assistant/attempt 的 usage 没有 message.source，
     * 归到该模型名下（只影响 models 展示聚合，不影响总 token）。
     * @type {{ key: string, provider: string, model: string } | null}
     */
    lastModel: null,
  }
}

/**
 * `stats.turn.tokenSample` 的快照：记住这次 token 记到了哪个小时桶/模型，替换时按原路撤回。
 * @typedef {Object} TokenSampleContext
 * @property {number | null} turn
 * @property {number | null} step
 * @property {TokenBucket} buckets
 * @property {number | null} hourKey
 * @property {string} modelKey
 * @property {number} costCNY 这次采样结算的估算成本（替换时按原路撤回）
 */

// ─────────────────────────────────────────────────────────────────────────────
// 会话统计对象
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 新建一个空的会话统计对象。
 * @param {object | null | undefined} header SessionHeader（可空，字段全部兜底）
 * @param {Record<string, object> | null | undefined} [pricing] 价格表（缺省用内置峰谷表；collect 传 config.pricing）
 * @param {Set<string> | string[] | null | undefined} [holidays] 节假日集合（缺省用内置 2025/2026 表）
 * @returns {SessionStats}
 */
export function emptySessionStats(header, pricing, holidays) {
  const source = header && typeof header === 'object' ? header : EMPTY_OBJECT
  return {
    // ── 身份（来自 SessionHeader，之后不变）──
    id: nonEmptyString(source.id) ?? '',
    createdAt: finiteNumber(source.createdAt),
    cwd: nonEmptyString(source.cwd),
    parentSession: nonEmptyString(source.parentSession),
    origin: nonEmptyString(source.origin),
    delegationDepth: finiteNumber(source.delegationDepth),
    agentPreset: nonEmptyString(source.agentPreset),
    isSeeded: source.isSeeded === true,
    version: finiteNumber(source.version),

    // ── 折叠出来的动态字段 ──
    title: '',
    firstEventAt: null,
    lastActivityAt: null,
    lastSeq: -1,
    eventCount: 0,

    // ── token 合计（全时段）+ 估算成本（CNY，按事件时间峰谷价累计）──
    ...emptyTokenBucket(),

    // ── 价格表 + 节假日集合（不落盘；revive 时重新注入）──
    pricing: pricing && typeof pricing === 'object' ? pricing : BUILTIN_PRICING,
    holidays: resolveHolidaySet(holidays),

    // ── 计数合计（全时段）──
    requests: 0,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    errorTurns: 0,
    interruptedTurns: 0,

    // ── 时序合计（全时段；毫秒）──
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftCount: 0,
    decodeMs: 0,
    decodeTokens: 0,

    // ── 按小时聚合（range 裁剪的唯一数据来源）──
    /** @type {Map<number, HourBucket>} */
    hours: new Map(),
    // ── 按模型聚合（全时段；models 表由 hours[].byModel 裁剪后派生）──
    /** @type {Map<string, ModelStats>} */
    models: new Map(),

    // ── 时序样本（算百分位；times 与 samples 一一对应，按事件时间升序）──
    /** @type {number[]} */
    ttftSamples: [],
    /** @type {number[]} */
    ttftSampleTimes: [],
    /** @type {number[]} */
    tpsSamples: [],
    /** @type {number[]} */
    tpsSampleTimes: [],

    turn: newTurnState(),
  }
}

/**
 * @typedef {Object} TokenBucket
 * @property {number} uncachedInputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} outputTokens
 * @property {number} reasoningTokens
 * @property {number} costCNY 估算成本（CNY，按 token 发生时刻的峰谷价累计）
 */

/**
 * @typedef {TokenBucket & {
 *   t: number,
 *   requests: number,
 *   turns: number,
 *   steps: number,
 *   toolCalls: number,
 *   errorTurns: number,
 *   interruptedTurns: number,
 *   llmMs: number,
 *   toolMs: number,
 *   byModel: Map<string, TokenBucket>,
 * }} HourBucket
 */

/**
 * @typedef {TokenBucket & {
 *   provider: string,
 *   model: string,
 *   requests: number,
 *   ttftMs: number,
 *   ttftCount: number,
 *   decodeMs: number,
 *   decodeTokens: number,
 * }} ModelStats
 */

/**
 * @typedef {Object} SessionStats
 * @property {string} id
 * @property {number | null} createdAt
 * @property {string | null} cwd
 * @property {string | null} parentSession
 * @property {string | null} origin
 * @property {number | null} delegationDepth
 * @property {string | null} agentPreset
 * @property {boolean} isSeeded
 * @property {number | null} version
 * @property {string} title
 * @property {number | null} firstEventAt
 * @property {number | null} lastActivityAt
 * @property {number} lastSeq
 * @property {number} eventCount
 * @property {number} uncachedInputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} outputTokens
 * @property {number} reasoningTokens
 * @property {number} costCNY 全时段估算成本（CNY，按事件时间峰谷价累计）
 * @property {Record<string, object>} pricing 价格表（不落盘）
 * @property {number} requests
 * @property {number} turns
 * @property {number} steps
 * @property {number} toolCalls
 * @property {number} errorTurns
 * @property {number} interruptedTurns
 * @property {number} llmMs
 * @property {number} toolMs
 * @property {number} ttftMs
 * @property {number} ttftCount
 * @property {number} decodeMs
 * @property {number} decodeTokens
 * @property {Map<number, HourBucket>} hours
 * @property {Map<string, ModelStats>} models
 * @property {number[]} ttftSamples
 * @property {number[]} ttftSampleTimes
 * @property {number[]} tpsSamples
 * @property {number[]} tpsSampleTimes
 * @property {TurnState} turn
 */

/**
 * @typedef {Object} TurnState
 * @property {{ turn: number | null, step: number | null, startTime: number | null, firstTokenTime: number | null } | null} openStep
 * @property {Map<string, number>} pendingCalls
 * @property {number | null} lastTurn
 * @property {TokenSampleContext | null} tokenSample
 * @property {{ key: string, provider: string, model: string } | null} lastModel
 */

// ─────────────────────────────────────────────────────────────────────────────
// 折叠主入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把一个事件折叠进会话统计（原地修改 stats）。未知事件类型静默跳过。
 * @param {SessionStats} stats
 * @param {object} event SessionEvent
 * @returns {SessionStats} 同一个 stats（便于链式调用）
 */
export function foldEvent(stats, event) {
  if (!stats || typeof stats !== 'object' || !event || typeof event !== 'object') return stats
  const type = typeof event.type === 'string' ? event.type : ''
  const data = event.data && typeof event.data === 'object' ? event.data : EMPTY_OBJECT
  const time = finiteNumber(event.time)
  const seq = finiteNumber(event.seq)

  if (seq !== null && seq > stats.lastSeq) stats.lastSeq = seq
  stats.eventCount += 1
  if (time !== null) {
    if (stats.firstEventAt === null || time < stats.firstEventAt) stats.firstEventAt = time
    if (stats.lastActivityAt === null || time > stats.lastActivityAt) stats.lastActivityAt = time
  }
  const at = time ?? stats.lastActivityAt

  switch (type) {
    case 'session/title': {
      const title = nonEmptyString(data.title)
      if (title !== null) stats.title = title
      break
    }
    case 'step/start': {
      stats.turn.openStep = {
        turn: finiteNumber(data.turn),
        step: finiteNumber(data.step),
        startTime: time,
        firstTokenTime: null,
      }
      break
    }
    case 'assistant/attempt': {
      // 重试时 assistant/attempt 可能先报出 stream 里的首 token 时间，最终
      // assistant/message 的 stream 可能不完整，因此先把首 token 时间记下来。
      const open = stats.turn.openStep
      if (open && open.firstTokenTime === null && sameStep(open, data)) {
        const firstTokenTime = streamFirstTokenTime(data.stream)
        if (firstTokenTime !== null) open.firstTokenTime = firstTokenTime
      }
      // attempt 的 stream 里也可能带 usage chunk（失败/中断的尝试同样消耗 token，
      // 与 dsh-token-meter 的 usageOf 一致：attempt 只从 stream 取 usage）。
      const attemptUsage = usageOf(event)
      if (attemptUsage !== null) {
        const lastModel = stats.turn.lastModel
        applyTokenSample(stats, normalizeUsage(attemptUsage), {
          turn: finiteNumber(data.turn),
          step: finiteNumber(data.step),
          hourAt: at,
          key: lastModel !== null ? lastModel.key : UNKNOWN_MODEL_KEY,
          provider: lastModel !== null ? lastModel.provider : 'unknown',
          model: lastModel !== null ? lastModel.model : 'unknown',
        })
      }
      break
    }
    case 'assistant/message': {
      foldAssistantMessage(stats, event, time, at)
      break
    }
    case 'llm/retry-started': {
      // 与 dsh-token-meter 一致：只有 (turn, step) 匹配时才清空最近采样引用，
      // **不撤回**已经计入的 token/requests（失败的重试也真实消耗 token）。
      const turn = finiteNumber(data.turn)
      const step = finiteNumber(data.step)
      const sample = stats.turn.tokenSample
      if (sample !== null && sample.turn === turn && sample.step === step) stats.turn.tokenSample = null
      break
    }
    case 'tool/call': {
      addToolCall(stats, data, time, at)
      break
    }
    case 'tool/result': {
      closeToolCall(stats, data, time, at)
      break
    }
    case 'step/end': {
      const turn = finiteNumber(data.turn)
      if (stats.turn.lastTurn !== turn) {
        stats.turns += 1
        stats.turn.lastTurn = turn
        addCountToHour(stats, at, 'turns')
      }
      stats.steps += 1
      addCountToHour(stats, at, 'steps')
      stats.turn.openStep = null
      break
    }
    case 'turn/end': {
      const kind = nonEmptyString(data.reason?.kind)
      const hourBucket = kind !== null ? ensureHourBucket(stats, at) : null
      if (kind === 'error' || kind === 'blocked' || kind === 'max-tokens') {
        stats.errorTurns += 1
        if (hourBucket) hourBucket.errorTurns += 1
      } else if (kind === 'aborted' || kind === 'interrupted') {
        stats.interruptedTurns += 1
        if (hourBucket) hourBucket.interruptedTurns += 1
      }
      stats.turn.pendingCalls.clear()
      stats.turn.openStep = null
      break
    }
    default:
      // 其余事件类型（request/header、user/message、session/title-llm-request、
      // team/task、job/*、sandbox/*……）与用量无关，安全跳过。
      break
  }
  return stats
}

/**
 * 批量折叠。等价于 for (const event of events) foldEvent(stats, event)。
 * @param {SessionStats} stats
 * @param {Iterable<object>} events
 * @returns {SessionStats}
 */
export function foldEvents(stats, events) {
  if (!stats || !events) return stats
  for (const event of events) foldEvent(stats, event)
  return stats
}

/** @returns {boolean} openStep 是否与事件 data 的 turn/step 匹配。 */
function sameStep(openStep, data) {
  return finiteNumber(data.turn) === openStep.turn && finiteNumber(data.step) === openStep.step
}

/**
 * 折叠一条 assistant/message：token 分桶（dsh-token-meter addReplacing 语义）、
 * per-model 统计、llm/ttft/decode 时序，以及 requests 单调计数。
 * @param {SessionStats} stats
 * @param {object} event assistant/message 事件
 * @param {number | null} time 事件时间
 * @param {number | null} at 用于分桶的时间（time 缺失时退回 lastActivityAt）
 */
function foldAssistantMessage(stats, event, time, at) {
  const data = event.data && typeof event.data === 'object' ? event.data : EMPTY_OBJECT
  const message = data.message && typeof data.message === 'object' ? data.message : EMPTY_OBJECT
  const source = message.source && typeof message.source === 'object' ? message.source : EMPTY_OBJECT
  const provider = nonEmptyString(source.provider) ?? 'unknown'
  const model = nonEmptyString(source.model) ?? 'unknown'
  const key = modelKeyOf(provider, model)
  const sample = usageOf(event)
  const outputTokens = sample !== null ? nonNegativeNumber(sample.outputTokens) : 0

  // ── 时序：与 dsh-session-stats 的 projection 同口径 ──
  const open = stats.turn.openStep
  const firstTokenFromStream = streamFirstTokenTime(data.stream)
  let llmMs = 0
  let ttftMs = null
  let decodeMs = 0
  let decodeTokens = 0
  let firstTokenTime = null
  let startTime = null

  if (open && sameStep(open, data)) {
    firstTokenTime = open.firstTokenTime ?? firstTokenFromStream
    startTime = open.startTime
    if (startTime !== null && time !== null) {
      llmMs = Math.max(0, time - startTime)
      stats.llmMs += llmMs
    }
    stats.turn.openStep = null
    if (firstTokenTime !== null && startTime !== null) {
      ttftMs = Math.max(0, firstTokenTime - startTime)
      stats.ttftMs += ttftMs
      stats.ttftCount += 1
    }
    if (firstTokenTime !== null && time !== null && outputTokens > 0) {
      decodeMs = Math.max(0, time - firstTokenTime)
      decodeTokens = outputTokens
      stats.decodeMs += decodeMs
      stats.decodeTokens += decodeTokens
    }
  } else {
    // 没有匹配的 step/start（例如从中间切开的增量折叠）：token 照常计，时序不估。
    firstTokenTime = firstTokenFromStream
  }

  // ── token：同一个 (turn, step) 的新采样替换旧采样；同值不重复累加 ──
  if (sample !== null) {
    applyTokenSample(stats, normalizeUsage(sample), {
      turn: finiteNumber(data.turn),
      step: finiteNumber(data.step),
      hourAt: at,
      key,
      provider,
      model,
    })
  }

  // ── requests：单调计数（= assistant/message 条数；重试替换时绝不减少）──
  stats.requests += 1
  addCountToHour(stats, at, 'requests')
  const modelStats = upsertModelStats(stats, key, provider, model)
  modelStats.requests += 1
  const hourBucket = ensureHourBucket(stats, at)
  if (hourBucket !== null) {
    let modelBucket = hourBucket.byModel.get(key)
    if (!modelBucket) {
      modelBucket = { ...emptyTokenBucket(), requests: 0 }
      hourBucket.byModel.set(key, modelBucket)
    }
    modelBucket.requests += 1
    if (llmMs > 0) hourBucket.llmMs += llmMs
  }

  // ── 时序样本（ttft 用首个 token 的时间戳做时间轴，tps 用事件时间）──
  if (ttftMs !== null && firstTokenTime !== null) {
    modelStats.ttftMs += ttftMs
    modelStats.ttftCount += 1
    stats.ttftSamples.push(ttftMs)
    stats.ttftSampleTimes.push(firstTokenTime)
  }
  if (decodeMs > 0 && decodeTokens > 0) {
    modelStats.decodeMs += decodeMs
    modelStats.decodeTokens += decodeTokens
    const tokensPerSec = decodeTokens / (decodeMs / 1000)
    if (Number.isFinite(tokensPerSec) && tokensPerSec > 0) {
      stats.tpsSamples.push(tokensPerSec)
      stats.tpsSampleTimes.push(time ?? firstTokenTime ?? 0)
    }
  }

  stats.turn.lastModel = { key, provider, model }
}

/**
 * 取一条事件里的有效 TokenUsage，语义对齐 `dsh-token-meter` 的 `usageOf(event)`：
 * assistant/message 优先用 `data.usage`，缺失时回退到 stream 里最后一个 usage chunk；
 * assistant/attempt 只从 stream 取（其 data 里没有 usage 字段）。
 * @param {object} event
 * @returns {object | null}
 */
function usageOf(event) {
  if (!event || typeof event !== 'object') return null
  const type = event.type
  if (type !== 'assistant/message' && type !== 'assistant/attempt') return null
  const data = event.data && typeof event.data === 'object' ? event.data : EMPTY_OBJECT
  if (type === 'assistant/message') {
    const usage = data.usage
    if (usage !== undefined && usage !== null) return typeof usage === 'object' ? usage : null
  }
  return streamUsage(data.stream)
}

/** dsh-token-meter 判等用的 4 个字段（reasoning 不参与判等）。 */
const TOKEN_REPLACE_FIELDS = Object.freeze([
  'uncachedInputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
])

/** @returns {boolean} 两个 token 桶在权威字段上是否相等。 */
function tokenBucketsEqual(left, right) {
  for (const field of TOKEN_REPLACE_FIELDS) {
    if (left[field] !== right[field]) return false
  }
  return true
}

/**
 * 应用一次 token 采样（严格对齐 `dsh-token-meter` 的 addReplacing 语义）：
 *   previous = 同 (turn, step) 的上一次采样；
 *   previous 存在且数值相同 → 不重复累加；
 *   否则先按原路撤回 previous，再累加本次采样。
 * @param {SessionStats} stats
 * @param {TokenBucket} usage 归一化后的 token 桶
 * @param {{ turn: number | null, step: number | null, hourAt: number | null, key: string, provider: string, model: string }} context
 * @returns {boolean} 是否真的改变了 token 合计
 */
function applyTokenSample(stats, usage, context) {
  const { turn, step, hourAt, key, provider, model } = context
  const last = stats.turn.tokenSample
  const previous = last !== null && last.turn === turn && last.step === step ? last : null
  if (previous !== null && tokenBucketsEqual(previous.buckets, usage)) return false
  if (previous !== null) subtractTokenSample(stats, previous)
  // 成本按**这次 token 发生的事件时间**结算：hourAt 决定 peak / off-peak 档位。
  const costCNY = tokenSampleCostCNY(stats, usage, model, hourAt)
  addUsage(stats, usage)
  stats.costCNY = nonNegativeNumber(stats.costCNY) + costCNY
  const hourKey = addUsageToHour(stats, hourAt, key, usage, costCNY)
  const modelStats = upsertModelStats(stats, key, provider, model)
  addUsage(modelStats, usage)
  modelStats.costCNY = nonNegativeNumber(modelStats.costCNY) + costCNY
  stats.turn.tokenSample = { turn, step, buckets: usage, hourKey, modelKey: key, costCNY }
  return true
}

/**
 * 一次 token 采样在事件时刻的估算成本（CNY）。未知模型返回 0。
 * @param {SessionStats} stats
 * @param {TokenBucket} usage
 * @param {string} model
 * @param {number | null} at 事件时间（决定峰谷档）
 * @returns {number}
 */
function tokenSampleCostCNY(stats, usage, model, at) {
  const price = priceFor(model, stats.pricing, at, stats.holidays)
  if (price === null) return 0
  return costOf(usage, price)
}

/**
 * 按记录的原路撤回一次 token 采样（只在被同 (turn, step) 的新采样替换时使用）。
 * @param {SessionStats} stats
 * @param {TokenSampleContext} sample
 */
function subtractTokenSample(stats, sample) {
  subtractUsage(stats, sample.buckets)
  const costCNY = nonNegativeNumber(sample.costCNY)
  if (costCNY > 0) stats.costCNY = Math.max(0, nonNegativeNumber(stats.costCNY) - costCNY)
  if (sample.hourKey !== null) {
    const bucket = stats.hours.get(sample.hourKey)
    if (bucket) {
      subtractUsage(bucket, sample.buckets)
      if (costCNY > 0) bucket.costCNY = Math.max(0, nonNegativeNumber(bucket.costCNY) - costCNY)
      subtractUsageFromBucketModel(bucket, sample.modelKey, sample.buckets, costCNY)
    }
  }
  const modelStats = stats.models.get(sample.modelKey)
  if (modelStats) {
    subtractUsage(modelStats, sample.buckets)
    if (costCNY > 0) modelStats.costCNY = Math.max(0, nonNegativeNumber(modelStats.costCNY) - costCNY)
  }
}

/**
 * 折叠 tool/call：记录派发时间（供 tool/result 配对算工具墙钟），并给小时桶 +1 工具调用。
 * @param {SessionStats} stats
 * @param {object} data
 * @param {number | null} time 事件时间（派发时间）
 * @param {number | null} at 分桶时间
 */
function addToolCall(stats, data, time, at) {
  stats.toolCalls += 1
  addCountToHour(stats, at, 'toolCalls')
  const callId = nonEmptyString(data.callId)
  if (callId !== null && time !== null) stats.turn.pendingCalls.set(callId, time)
}

/**
 * 折叠 tool/result：按 callId 配对 tool/call，累加工具墙钟。
 * @param {SessionStats} stats
 * @param {object} data
 * @param {number | null} time
 * @param {number | null} at 分桶时间
 */
function closeToolCall(stats, data, time, at) {
  const message = data.message && typeof data.message === 'object' ? data.message : null
  const source = message && message.source && typeof message.source === 'object' ? message.source : null
  // 真实日志（2026-11 实测）里 tool/result 的配对键是 message.toolCallId；
  // 也兼容 data.callId / message.source.callId 两种历史写法。
  const callId =
    (message ? nonEmptyString(message.toolCallId) : null) ??
    nonEmptyString(data.callId) ??
    (source ? nonEmptyString(source.callId) : null)
  if (callId === null || time === null) return
  if (!stats.turn.pendingCalls.has(callId)) return
  const dispatched = stats.turn.pendingCalls.get(callId)
  stats.turn.pendingCalls.delete(callId)
  if (typeof dispatched === 'number' && Number.isFinite(dispatched)) {
    const duration = Math.max(0, time - dispatched)
    stats.toolMs += duration
    const hourBucket = ensureHourBucket(stats, at)
    if (hourBucket) hourBucket.toolMs += duration
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// usage / stream 解析
// ─────────────────────────────────────────────────────────────────────────────

/** TokenUsage 的字段名（内部统一口径）。 */
const TOKEN_FIELDS = Object.freeze([
  'uncachedInputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens',
])

/**
 * 把平台的 TokenUsage 归一化成内部 token 桶。
 * @param {object | null | undefined} usage
 * @returns {TokenBucket}
 */
function normalizeUsage(usage) {
  const source = usage && typeof usage === 'object' ? usage : EMPTY_OBJECT
  return {
    // ⚠️ usage.inputTokens 是「未缓存输入」，不是总输入（真实日志已验证）。
    uncachedInputTokens: nonNegativeNumber(source.inputTokens),
    cacheReadTokens: nonNegativeNumber(source.cacheReadTokens),
    cacheWriteTokens: nonNegativeNumber(source.cacheWriteTokens),
    outputTokens: nonNegativeNumber(source.outputTokens),
    // reasoning 已经包含在 outputTokens 里，这里只做展示，绝不重复计成本。
    reasoningTokens: nonNegativeNumber(source.reasoningTokens),
  }
}

/**
 * data.usage 缺失时，从 stream 的最后一个 usage chunk 兜底取 TokenUsage。
 * @param {unknown} stream
 * @returns {object | null}
 */
function streamUsage(stream) {
  if (!Array.isArray(stream)) return null
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (!record || typeof record !== 'object') continue
    if (record.type === 'chunk' && record.chunk && typeof record.chunk === 'object') {
      if (record.chunk.type === 'usage') {
        const usage = record.chunk.usage ?? record.chunk.data
        if (usage && typeof usage === 'object') return usage
      }
    } else if (record.type === 'usage') {
      const usage = record.usage ?? record.data
      if (usage && typeof usage === 'object') return usage
    }
  }
  return null
}

/**
 * 判断一个流式 chunk 是否算「token delta」（对齐 dsh-llm 的 isTokenDelta）。
 * @param {object | null | undefined} chunk
 * @returns {boolean}
 */
function isTokenDelta(chunk) {
  if (!chunk || typeof chunk !== 'object') return false
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

/**
 * run 型 stream record 里首个满足条件的成员时间。
 * 成员时间 = time0，之后第 i 个成员再加 dt[i-1]（dt 是「与上一个成员的时间差」）。
 * @param {object} record
 * @param {(member: unknown) => boolean} predicate
 * @returns {number | null}
 */
function firstRunMemberTime(record, predicate) {
  const time0 = finiteNumber(record.time0)
  if (time0 === null) return null
  const members = Array.isArray(record.texts)
    ? record.texts
    : Array.isArray(record.args)
      ? record.args
      : null
  if (!members) return null
  const dt = Array.isArray(record.dt) ? record.dt : []
  let time = time0
  for (let index = 0; index < members.length; index += 1) {
    if (index > 0) time += nonNegativeNumber(dt[index - 1])
    if (predicate(members[index])) return time
  }
  return null
}

/**
 * 首个非空 delta 的时间戳（对齐 dsh-session-stats 的
 * `assistantStreamFirstTokenTime`）：同时支持 chunk 型与 run 型 stream record。
 * @param {unknown} stream
 * @returns {number | null}
 */
function streamFirstTokenTime(stream) {
  if (!Array.isArray(stream)) return null
  for (const record of stream) {
    if (!record || typeof record !== 'object') continue
    if (record.type === 'chunk') {
      if (isTokenDelta(record.chunk)) {
        const time = finiteNumber(record.time)
        if (time !== null) return time
      }
      continue
    }
    if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
      const time = firstRunMemberTime(record, (member) => member !== '')
      if (time !== null) return time
      continue
    }
    if (record.type === 'tool-call-chunks') {
      // 工具调用名到达即可视为一个 token（与参考实现一致）。
      if (record.name !== undefined) {
        const time0 = finiteNumber(record.time0)
        if (time0 !== null) return time0
      }
      const time = firstRunMemberTime(record, (member) => member !== '')
      if (time !== null) return time
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 聚合
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 token 桶的五个字段加到任意带同名字段的对象上（stats / HourBucket / ModelStats）。
 * @param {Record<string, number>} target
 * @param {TokenBucket} usage
 */
function addUsage(target, usage) {
  for (const field of TOKEN_FIELDS) target[field] = nonNegativeNumber(target[field]) + usage[field]
}

/**
 * 从对象上减掉 token 桶（重试替换用；结果不为负）。
 * @param {Record<string, number>} target
 * @param {TokenBucket} usage
 */
function subtractUsage(target, usage) {
  for (const field of TOKEN_FIELDS) {
    target[field] = Math.max(0, nonNegativeNumber(target[field]) - usage[field])
  }
}

/** @returns {HourBucket} */
function emptyHourBucket(t) {
  return {
    t,
    requests: 0,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    errorTurns: 0,
    interruptedTurns: 0,
    llmMs: 0,
    toolMs: 0,
    byModel: new Map(),
    ...emptyTokenBucket(),
  }
}

/**
 * 取（必要时创建）事件时间所在的小时桶。
 * @param {SessionStats} stats
 * @param {number | null} at
 * @returns {HourBucket | null}
 */
function ensureHourBucket(stats, at) {
  const hourKey = hourKeyOf(at)
  if (hourKey === null) return null
  let bucket = stats.hours.get(hourKey)
  if (!bucket) {
    bucket = emptyHourBucket(hourKey)
    stats.hours.set(hourKey, bucket)
  }
  return bucket
}

/** 给小时桶的某个计数 +1。 */
function addCountToHour(stats, at, field) {
  const bucket = ensureHourBucket(stats, at)
  if (bucket) bucket[field] += 1
}

/**
 * token 记入小时桶，并同步记入该小时的 per-model 桶（供 models 表按 range 裁剪）。
 * @param {SessionStats} stats
 * @param {number | null} at
 * @param {string} key 模型复合键
 * @param {TokenBucket} usage
 * @param {number} [costCNY] 与 usage 一起结算的估算成本
 * @returns {number | null} 命中的小时桶键
 */
function addUsageToHour(stats, at, key, usage, costCNY) {
  const bucket = ensureHourBucket(stats, at)
  if (!bucket) return null
  addUsage(bucket, usage)
  bucket.costCNY = nonNegativeNumber(bucket.costCNY) + nonNegativeNumber(costCNY)
  let modelBucket = bucket.byModel.get(key)
  if (!modelBucket) {
    modelBucket = { ...emptyTokenBucket(), requests: 0 }
    bucket.byModel.set(key, modelBucket)
  }
  addUsage(modelBucket, usage)
  modelBucket.costCNY = nonNegativeNumber(modelBucket.costCNY) + nonNegativeNumber(costCNY)
  return bucket.t
}

/** 从小时桶的 per-model 桶里减掉 token（重试替换用）。 */
function subtractUsageFromBucketModel(bucket, key, usage, costCNY) {
  const modelBucket = bucket.byModel.get(key)
  if (!modelBucket) return
  subtractUsage(modelBucket, usage)
  const cost = nonNegativeNumber(costCNY)
  if (cost > 0) modelBucket.costCNY = Math.max(0, nonNegativeNumber(modelBucket.costCNY) - cost)
}

/**
 * 取（必要时创建）模型聚合项。
 * @returns {ModelStats}
 */
function upsertModelStats(stats, key, provider, model) {
  let entry = stats.models.get(key)
  if (!entry) {
    entry = {
      provider,
      model,
      requests: 0,
      ttftMs: 0,
      ttftCount: 0,
      decodeMs: 0,
      decodeTokens: 0,
      ...emptyTokenBucket(),
    }
    stats.models.set(key, entry)
  }
  return entry
}

// ─────────────────────────────────────────────────────────────────────────────
// 定价
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {number | null} 第一个有限数字参数。 */
function firstFinite(...values) {
  for (const value of values) {
    const number = finiteNumber(value)
    if (number !== null) return number
  }
  return null
}

/** @returns {string | null} 从字符串或 { model, name, id } 形状里取模型 id。 */
function modelNameOf(model) {
  if (typeof model === 'string') return model === '' ? null : model
  if (model && typeof model === 'object') {
    return nonEmptyString(model.model) ?? nonEmptyString(model.name) ?? nonEmptyString(model.id)
  }
  return null
}

/** @returns {string[]} 价格表查找候选（含去 provider 前缀与别名）。 */
function priceCandidates(name) {
  const list = [name]
  const alias = MODEL_ALIASES[name]
  if (alias) list.push(alias)
  const slash = name.lastIndexOf('/')
  if (slash >= 0 && slash < name.length - 1) list.push(name.slice(slash + 1))
  const lower = name.toLowerCase()
  if (lower !== name) list.push(lower)
  return list.filter((value, index) => value !== '' && list.indexOf(value) === index)
}

/**
 * 归一化一条价格表项。允许两种写法：
 *  - 内部写法 `{ input, cacheRead, cacheWrite, output }`；
 *  - CONTRACT §5 的配置写法 `{ cacheMiss, cacheRead, output }`（cacheMiss 即未缓存输入）。
 * @returns {{ input: number, cacheRead: number, cacheWrite: number, output: number } | null}
 */
function normalizePriceEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const input = firstFinite(entry.input, entry.cacheMiss, entry.cacheMissPrice, entry.uncachedInput, entry.inputPrice)
  const cacheRead = firstFinite(entry.cacheRead, entry.cacheHit, entry.cacheHitPrice, entry.readPrice)
  const cacheWrite = firstFinite(entry.cacheWrite, entry.cacheWritePrice, entry.writePrice) ?? input
  const output = firstFinite(entry.output, entry.outputPrice)
  if (input === null && cacheRead === null && output === null) return null
  return {
    input: input ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    output: output ?? 0,
  }
}

/**
 * 返回一份「每档价减半」的副本（旧扁平价 → off-peak 档）。
 * @param {{ input: number, cacheRead: number, cacheWrite: number, output: number }} price
 * @returns {{ input: number, cacheRead: number, cacheWrite: number, output: number }}
 */
function halvePrice(price) {
  return {
    input: nonNegativeNumber(price.input) / 2,
    cacheRead: nonNegativeNumber(price.cacheRead) / 2,
    cacheWrite: nonNegativeNumber(price.cacheWrite) / 2,
    output: nonNegativeNumber(price.output) / 2,
  }
}

/**
 * 把一条价格表项归一化成峰谷两档。兼容旧扁平写法（视为 peak，off-peak 自动减半）。
 * @returns {{ peak: { input: number, cacheRead: number, cacheWrite: number, output: number }, offPeak: { input: number, cacheRead: number, cacheWrite: number, output: number } } | null}
 */
function normalizePricePair(entry) {
  if (!entry || typeof entry !== 'object') return null
  const hasPeak = entry.peak !== undefined && entry.peak !== null && typeof entry.peak === 'object'
  const peak = normalizePriceEntry(hasPeak ? entry.peak : entry)
  if (peak === null) return null
  const hasOffPeak = entry.offPeak !== undefined && entry.offPeak !== null && typeof entry.offPeak === 'object'
  const offPeak = (hasOffPeak ? normalizePriceEntry(entry.offPeak) : null) ?? halvePrice(peak)
  return { peak, offPeak }
}

/**
 * 查模型价格（按事件时间选峰谷档）。未知模型返回 null（对应 `priced:false`、成本按 0）。
 *
 * 向后兼容：
 *  - `prices` 项是**扁平** `{input,cacheRead,cacheWrite,output}`（或配置写法 `{cacheMiss,cacheRead,output}`）
 *    → 视为 **peak 价**；off-peak 时段自动按官方规则减半。价格一律视为 **CNY / 1M tokens**。
 *  - `prices` 项是 `{peak:{…}, offPeak:{…}}` → 直接取对应档。
 * @param {string | { model?: string, name?: string, id?: string }} model
 * @param {Record<string, object> | null | undefined} prices 覆盖表；空对象/未传时用内置表
 * @param {number} [timeMs] 事件发生时间（epoch ms）。缺省/非有限数按 **peak** 档（保守上界）
 * @param {Set<string> | string[]} [holidays] 中国法定节假日集合（缺省用内置 2025/2026 表）
 * @returns {{ input: number, cacheRead: number, cacheWrite: number, output: number } | null} CNY / 1M tokens（权威基准）
 */
export function priceFor(model, prices, timeMs, holidays) {
  const name = modelNameOf(model)
  if (name === null) return null
  const table =
    prices && typeof prices === 'object' && Object.keys(prices).length > 0 ? prices : BUILTIN_PRICING
  const time = finiteNumber(timeMs)
  const peak = time === null ? true : isPeakHour(time, holidays)
  for (const candidate of priceCandidates(name)) {
    if (Object.hasOwn(table, candidate)) {
      const pair = normalizePricePair(table[candidate])
      if (pair) return peak ? pair.peak : pair.offPeak
    }
  }
  return null
}

/**
 * 按三档价估算 **CNY** 成本（人民币是权威基准；USD 展示值由调用方除以汇率派生）。
 * 未知价格（price 为 null）时返回 0。
 * @param {TokenBucket | null | undefined} tokens
 * @param {{ input: number, cacheRead: number, cacheWrite: number, output: number } | null | undefined} price
 *   CNY / 1M tokens
 * @returns {number} CNY
 */
export function costOf(tokens, price) {
  if (!tokens || typeof tokens !== 'object' || !price || typeof price !== 'object') return 0
  const units =
    nonNegativeNumber(tokens.uncachedInputTokens) * nonNegativeNumber(price.input) +
    nonNegativeNumber(tokens.cacheReadTokens) * nonNegativeNumber(price.cacheRead) +
    nonNegativeNumber(tokens.cacheWriteTokens) * nonNegativeNumber(price.cacheWrite) +
    nonNegativeNumber(tokens.outputTokens) * nonNegativeNumber(price.output)
  const cny = units / 1_000_000
  return Number.isFinite(cny) && cny > 0 ? cny : 0
}

// ─────────────────────────────────────────────────────────────────────────────
// 序列化（可选磁盘缓存的读回/落盘；实时状态 turn.* 不持久化）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把统计对象转成可 JSON 序列化的纯对象（Map 转成 [key, value] 数组）。
 * @param {SessionStats} stats
 * @returns {object | null}
 */
export function serializeSessionStats(stats) {
  if (!stats || typeof stats !== 'object') return null
  const tokenSnapshot = {}
  for (const field of TOKEN_FIELDS) tokenSnapshot[field] = nonNegativeNumber(stats[field])
  return {
    id: stats.id,
    createdAt: stats.createdAt,
    cwd: stats.cwd,
    parentSession: stats.parentSession,
    origin: stats.origin,
    delegationDepth: stats.delegationDepth,
    agentPreset: stats.agentPreset,
    isSeeded: stats.isSeeded === true,
    version: stats.version,
    title: stats.title,
    firstEventAt: stats.firstEventAt,
    lastActivityAt: stats.lastActivityAt,
    lastSeq: stats.lastSeq,
    eventCount: stats.eventCount,
    ...tokenSnapshot,
    requests: stats.requests,
    turns: stats.turns,
    steps: stats.steps,
    toolCalls: stats.toolCalls,
    errorTurns: stats.errorTurns,
    interruptedTurns: stats.interruptedTurns,
    llmMs: stats.llmMs,
    toolMs: stats.toolMs,
    ttftMs: stats.ttftMs,
    ttftCount: stats.ttftCount,
    decodeMs: stats.decodeMs,
    decodeTokens: stats.decodeTokens,
    costCNY: nonNegativeNumber(stats.costCNY),
    hours: [...stats.hours.values()].map((bucket) => [
      bucket.t,
      {
        t: bucket.t,
        ...pickTokens(bucket),
        costCNY: nonNegativeNumber(bucket.costCNY),
        requests: bucket.requests,
        turns: bucket.turns,
        steps: bucket.steps,
        toolCalls: bucket.toolCalls,
        errorTurns: bucket.errorTurns,
        interruptedTurns: bucket.interruptedTurns,
        llmMs: bucket.llmMs,
        toolMs: bucket.toolMs,
        byModel: [...bucket.byModel.entries()].map(([key, value]) => [
          key,
          { ...pickTokens(value), costCNY: nonNegativeNumber(value.costCNY), requests: nonNegativeNumber(value.requests) },
        ]),
      },
    ]),
    models: [...stats.models.entries()].map(([key, value]) => [
      key,
      {
        provider: value.provider,
        model: value.model,
        ...pickTokens(value),
        costCNY: nonNegativeNumber(value.costCNY),
        requests: value.requests,
        ttftMs: value.ttftMs,
        ttftCount: value.ttftCount,
        decodeMs: value.decodeMs,
        decodeTokens: value.decodeTokens,
      },
    ]),
    ttftSamples: [...stats.ttftSamples],
    ttftSampleTimes: [...stats.ttftSampleTimes],
    tpsSamples: [...stats.tpsSamples],
    tpsSampleTimes: [...stats.tpsSampleTimes],
    lastTurn: stats.turn ? stats.turn.lastTurn : null,
  }
}

/** @returns {TokenBucket} */
function pickTokens(source) {
  const tokens = emptyTokenBucket()
  if (!source || typeof source !== 'object') return tokens
  for (const field of TOKEN_FIELDS) tokens[field] = nonNegativeNumber(source[field])
  return tokens
}

/** 恢复一对相互对齐的样本数组（任何一格不合法就成对丢弃）。 */
function restoreSamples(samples, times) {
  const sampleValues = Array.isArray(samples) ? samples : []
  const timeValues = Array.isArray(times) ? times : []
  const count = Math.min(sampleValues.length, timeValues.length)
  const restoredSamples = []
  const restoredTimes = []
  for (let index = 0; index < count; index += 1) {
    const sample = finiteNumber(sampleValues[index])
    const time = finiteNumber(timeValues[index])
    if (sample === null || time === null) continue
    restoredSamples.push(sample)
    restoredTimes.push(time)
  }
  return [restoredSamples, restoredTimes]
}

/**
 * 从 serializeSessionStats() 的结果恢复统计对象。损坏/不认识的输入返回 null。
 * turn.* 是纯实时状态，不恢复（缓存命中时它本来也该是空）。
 * @param {object | null | undefined} raw
 * @param {Record<string, object> | null | undefined} [pricing] 价格表（缺省内置；落盘不存价格表）
 * @param {Set<string> | string[] | null | undefined} [holidays] 节假日集合（缺省内置）
 * @returns {SessionStats | null}
 */
export function reviveSessionStats(raw, pricing, holidays) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || raw.id === '') return null
  const stats = emptySessionStats(raw, pricing, holidays)
  stats.title = typeof raw.title === 'string' ? raw.title : ''
  stats.firstEventAt = finiteNumber(raw.firstEventAt)
  stats.lastActivityAt = finiteNumber(raw.lastActivityAt)
  stats.lastSeq = finiteNumber(raw.lastSeq) ?? -1
  stats.eventCount = Math.max(0, nonNegativeNumber(raw.eventCount))
  for (const field of TOKEN_FIELDS) stats[field] = nonNegativeNumber(raw[field])
  stats.costCNY = nonNegativeNumber(raw.costCNY)
  for (const field of [
    'requests',
    'turns',
    'steps',
    'toolCalls',
    'errorTurns',
    'interruptedTurns',
    'llmMs',
    'toolMs',
    'ttftMs',
    'ttftCount',
    'decodeMs',
    'decodeTokens',
  ]) {
    stats[field] = nonNegativeNumber(raw[field])
  }
  if (Array.isArray(raw.hours)) {
    for (const entry of raw.hours) {
      if (!Array.isArray(entry) || entry.length !== 2) continue
      const t = finiteNumber(entry[0])
      const value = entry[1]
      if (t === null || !value || typeof value !== 'object') continue
      const bucket = emptyHourBucket(t)
      for (const field of TOKEN_FIELDS) bucket[field] = nonNegativeNumber(value[field])
      bucket.costCNY = nonNegativeNumber(value.costCNY)
      for (const field of [
        'requests',
        'turns',
        'steps',
        'toolCalls',
        'errorTurns',
        'interruptedTurns',
        'llmMs',
        'toolMs',
      ]) {
        bucket[field] = nonNegativeNumber(value[field])
      }
      if (Array.isArray(value.byModel)) {
        for (const modelEntry of value.byModel) {
          if (!Array.isArray(modelEntry) || modelEntry.length !== 2) continue
          if (typeof modelEntry[0] !== 'string') continue
          const modelBucket = pickTokens(modelEntry[1])
          modelBucket.costCNY = nonNegativeNumber(modelEntry[1]?.costCNY)
          modelBucket.requests = nonNegativeNumber(modelEntry[1]?.requests)
          bucket.byModel.set(modelEntry[0], modelBucket)
        }
      }
      stats.hours.set(t, bucket)
    }
  }
  if (Array.isArray(raw.models)) {
    for (const entry of raw.models) {
      if (!Array.isArray(entry) || entry.length !== 2) continue
      const key = entry[0]
      const value = entry[1]
      if (typeof key !== 'string' || !value || typeof value !== 'object') continue
      const modelStats = {
        provider: nonEmptyString(value.provider) ?? splitModelKey(key).provider,
        model: nonEmptyString(value.model) ?? splitModelKey(key).model,
        requests: nonNegativeNumber(value.requests),
        ttftMs: nonNegativeNumber(value.ttftMs),
        ttftCount: nonNegativeNumber(value.ttftCount),
        decodeMs: nonNegativeNumber(value.decodeMs),
        decodeTokens: nonNegativeNumber(value.decodeTokens),
        ...pickTokens(value),
        costCNY: nonNegativeNumber(value.costCNY),
      }
      stats.models.set(key, modelStats)
    }
  }
  ;[stats.ttftSamples, stats.ttftSampleTimes] = restoreSamples(raw.ttftSamples, raw.ttftSampleTimes)
  ;[stats.tpsSamples, stats.tpsSampleTimes] = restoreSamples(raw.tpsSamples, raw.tpsSampleTimes)
  stats.turn = newTurnState()
  stats.turn.lastTurn = finiteNumber(raw.lastTurn)
  return stats
}
