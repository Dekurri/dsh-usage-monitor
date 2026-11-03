/**
 * dsh-usage-monitor — Host 采集器：缓存 + 后台扫描 + 实时增量 + 契约组装。
 *
 * 契约（CONTRACT.md §3）：
 *   createCollector(ctx, config) -> {
 *     getOverview({ range, currency }): Promise<Overview>,
 *     getLive(): Live,          // 同步、非阻塞、必须 <50ms、不做 IO
 *     invalidate(sessionId?): void,
 *     start(): void,
 *     dispose(): void,
 *   }
 *
 * ── 数据来源（host-data 实测确认的方法名，记录在这里供后续维护）──────────────
 * - `ctx.sessionQuery.listSessions()`           → 全库会话清单（newest-first），
 *   每条 `{ header: SessionHeader, live: boolean, persisted: boolean }`。
 * - `ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })`
 *   → `SessionObservation { header, events, cursor, revision?, dispose() }`。
 *   这是全库冷读最省的路径：只 stat 单个会话、事件数组 `Object.freeze` 无深拷贝、
 *   `projectionMode:'none'` 跳过投影计算；返回的 lease 必须立即 dispose。
 *   （`readSession()` 会经过 corpus.load → 全库 stat + 每个事件 structuredClone，太慢，
 *   全库扫描不用它。）
 * - `ctx.on('session/event', (session, event))` → live 增量：只把新事件折进缓存，
 *   绝不重扫整个会话；seq 不连续时对该单会话做一次 debounce 重建。
 * - `ctx.sessions` 由 index.js 注入但本文件不直接调用：live 判定来自
 *   listSessions() 的 `record.live`，以及 session/event 是否仍在到达。
 *
 * ── 可靠性约定 ──────────────────────────────────────────────────────────────
 * - `createCollector` 构造期**不做任何 IO**（读缓存文件放在 start()）。
 * - `dispose()` 幂等；`getLive()` 与 `getOverview()` 都不允许抛异常。
 * - 所有对外数字 Number.isFinite 兜底（NaN→0），否则 UI 会显示 NaN。
 * - 只缓存非 live / 已折叠会话；live 会话靠事件增量，`rescanIntervalMs` 只做
 *   `listSessions()` 对账（发现新会话、刷新 live 标记、修剪已删除会话），
 *   不重复冷读已缓存的会话，避免 sessionQuery 内部 LRU（默认容量 5）导致每轮全量重读。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {
  BUILTIN_PRICING,
  CN_HOLIDAY_DAYS,
  CN_HOLIDAY_YEARS,
  HOUR_MS,
  PEAK_HOURS_UTC,
  PEAK_WEEKDAYS,
  PRICING_BASE_CURRENCY,
  PRICING_HOLIDAY_SOURCE,
  PRICING_UPDATED_AT,
  cacheHitRateOf,
  emptySessionStats,
  emptyTokenBucket,
  foldEvent,
  foldEvents,
  holidaySetOf,
  priceFor,
  reviveSessionStats,
  serializeSessionStats,
  splitModelKey,
  sumTokens,
} from './fold.js'
import { createSystemSampler } from './system.js'

/** 一天毫秒数。 */
const DAY_MS = 24 * HOUR_MS
/**
 * 落盘缓存格式版本号；不匹配直接丢弃（宁可重扫也不读坏数据）。
 * v4：成本字段改名 costCNY + 三字段；v5（=4）：内置表换官方人民币价、节假日谷价。
 */
const CACHE_VERSION = 4
/** 落盘缓存去抖延时。 */
const CACHE_SAVE_DELAY_MS = 5000
/** live 会话 seq 不连续时，单会话重建的去抖延时。 */
const RESCAN_DEBOUNCE_MS = 500
/** 单个会话冷读超时（毫秒）。 */
const SESSION_READ_TIMEOUT_MS = 20000
/** 后台扫描每批会话数（每批之间让出事件循环）。 */
const SCAN_CHUNK_SIZE = 8
/** 最近 60s 活跃窗口（用于 tokensPerMin / requestsPerMin）。 */
const RECENT_WINDOW_MS = 60000
/** `all` 范围按天分桶的上限；超过后按 7 天合并成周桶。 */
const MAX_ALL_DAY_BUCKETS = 90

/** token 的五个字段（与 fold.js 内部口径一致）。 */
const TOKEN_FIELDS = Object.freeze([
  'uncachedInputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens',
])

/** 支持的 range 定义。 */
const RANGE_DEFS = Object.freeze({
  // 今日（本地自然日 00:00 起）：与「滚动近 24h」区分，凌晨查看不会混入昨天的花费。
  today: { label: '今日（本地 00:00 起）', granularity: 'hour', days: 0 },
  '24h': { label: '近 24 小时', granularity: 'hour', days: 0 },
  '7d': { label: '近 7 天', granularity: 'day', days: 7 },
  '14d': { label: '近 14 天', granularity: 'day', days: 14 },
  '30d': { label: '近 30 天', granularity: 'day', days: 30 },
  all: { label: '全部', granularity: 'day', days: 0 },
})

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {number} 有限数字，否则 0。 */
function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** @returns {number} 正整数，否则 fallback。 */
function safePositiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** @returns {number} 整数并夹在 [min, max]。 */
function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/** CNY（权威基准）→ USD 展示值：除以配置汇率（1 USD = rate CNY）。 */
function cnyToUsd(cny, rate) {
  return safeNumber(cny) / safePositiveNumber(rate, 7.1)
}

/**
 * 归一化 config.pricingHolidays（追加的中国法定节假日）：只保留 'YYYY-MM-DD' 字符串，非法项忽略。
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeHolidayList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item)) out.push(item)
  }
  return out
}

/** @returns {Promise<void>} 让出一次事件循环（宏任务），保证扫描不长时间独占主线程。 */
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 默认落盘缓存路径：`$DSH_HOME/usage-monitor/cache.json`（契约 §5）。 */
function defaultCacheFile() {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
  return path.join(home, 'usage-monitor', 'cache.json')
}

/** 归一化插件配置，并给每个 key 补上契约 §5 的默认值。 */
function normalizeConfig(config) {
  const source = config && typeof config === 'object' ? config : {}
  const fx = source.fx && typeof source.fx === 'object' ? source.fx : {}
  const pricing =
    source.pricing && typeof source.pricing === 'object' && Object.keys(source.pricing).length > 0
      ? source.pricing
      : null
  const cacheFile =
    typeof source.cacheFile === 'string' && source.cacheFile.trim() !== ''
      ? source.cacheFile
      : defaultCacheFile()
  // v5：追加的法定节假日（内置 2025/2026 之外，用于新年度安排发布后补录）。
  const pricingHolidays = normalizeHolidayList(source.pricingHolidays)
  return {
    sampleIntervalMs: clampInt(source.sampleIntervalMs, 2000, 250, 60000),
    liveHistoryPoints: clampInt(source.liveHistoryPoints, 60, 2, 600),
    rescanIntervalMs: clampInt(source.rescanIntervalMs, 60000, 5000, 3600000),
    usdCnyRate: safePositiveNumber(fx.USDCNY, 7.1),
    pricing,
    pricingHolidays,
    cacheFile,
  }
}

/** 价格表：config.pricing 覆盖时用配置表，否则用内置表。 */
function pricingTable(settings) {
  return settings.pricing ?? BUILTIN_PRICING
}

/** 契约 §2.1 的 pricing 段。 */
function pricingInfo(settings) {
  const table = pricingTable(settings)
  const extraHolidays = Array.isArray(settings.pricingHolidays) ? settings.pricingHolidays : []
  return {
    source: settings.pricing ? 'config' : 'builtin',
    updatedAt: PRICING_UPDATED_AT,
    count: Object.keys(table).length,
    // 成本金额的权威基准币种：CNY（人民币）。USD 只是用 fxRate 派生的展示值。
    baseCurrency: PRICING_BASE_CURRENCY,
    // 峰谷定价（v3/v5）：成本按**事件时间**所在的 UTC 小时档位结算（off-peak = peak 的一半）。
    peakHoursUtc: PEAK_HOURS_UTC.map(([from, to]) => [from, to]),
    peakWeekdays: PEAK_WEEKDAYS,
    offPeakHalfPrice: true,
    // v5：内置 2025/2026 中国法定节假日（来源 NateScarlet/holiday-cn）；节假日与周末全天按谷价。
    holidaysIncluded: true,
    holidayYears: CN_HOLIDAY_YEARS.slice(),
    holidayDays: CN_HOLIDAY_DAYS.length,
    holidayExtraCount: extraHolidays.length,
    holidaySource: PRICING_HOLIDAY_SOURCE,
    holidayNote: '周末与中国法定节假日全天按谷价；未内置年份（如 2027）会按峰价计。',
  }
}

/** 本地日零点。 */
function startOfLocalDay(time) {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 本地自然周（周一）零点。 */
function startOfLocalWeek(time) {
  const date = new Date(startOfLocalDay(time))
  const offset = (date.getDay() + 6) % 7 // 周一=0 … 周日=6
  date.setDate(date.getDate() - offset)
  return date.getTime()
}

/** 桶标签：小时桶 `HH:00`；日/周桶 `M/D`（周桶再加「周」前缀）。 */
function formatBucketLabel(t, granularity) {
  const date = new Date(t)
  if (granularity === 'hour') return `${String(date.getHours()).padStart(2, '0')}:00`
  const label = `${date.getMonth() + 1}/${date.getDate()}`
  return granularity === 'week' ? `周 ${label}` : label
}

/**
 * 解析 range：返回时间轴（桶起点数组 + 标签 + 把「小时桶键」映射到时间轴下标的函数）。
 * - 24h → 24 个小时桶（对齐到当前小时）
 * - 7d/14d/30d → 本地日桶
 * - all → 本地日桶，超过 MAX_ALL_DAY_BUCKETS 天时按本地自然周合并
 * @param {string} key
 * @param {number} now
 * @param {number | null} earliest 全库最早活动时间（用于 all 的起点）
 */
function resolveRange(key, now, earliest) {
  const normalized = typeof key === 'string' && Object.hasOwn(RANGE_DEFS, key) ? key : '24h'
  const definition = RANGE_DEFS[normalized]
  let granularity = definition.granularity
  /** @type {number[]} */
  const starts = []

  if (normalized === 'today') {
    // 今日（本地自然日 00:00:00）→ 现在：按小时出桶（1–24 个桶，label `HH:00`）。
    const dayStart = startOfLocalDay(now)
    const endHour = Math.floor(now / HOUR_MS) * HOUR_MS
    for (let t = dayStart; t <= endHour; t += HOUR_MS) starts.push(t)
  } else if (granularity === 'hour') {
    const endHour = Math.floor(now / HOUR_MS) * HOUR_MS
    for (let index = 23; index >= 0; index -= 1) starts.push(endHour - index * HOUR_MS)
  } else if (normalized === 'all') {
    const today = startOfLocalDay(now)
    const firstDay = typeof earliest === 'number' && Number.isFinite(earliest) ? startOfLocalDay(earliest) : today
    const dayCount = Math.max(1, Math.round((today - firstDay) / DAY_MS) + 1)
    if (dayCount > MAX_ALL_DAY_BUCKETS) {
      // 超过 90 天：按本地自然周（周一起）合并，保证柱状图不至于几百根柱子。
      granularity = 'week'
      const firstWeek = startOfLocalWeek(firstDay)
      const lastWeek = startOfLocalWeek(today)
      const weekCount = Math.max(1, Math.round((lastWeek - firstWeek) / (7 * DAY_MS)) + 1)
      for (let index = 0; index < weekCount; index += 1) starts.push(firstWeek + index * 7 * DAY_MS)
    } else {
      for (let index = 0; index < dayCount; index += 1) starts.push(firstDay + index * DAY_MS)
    }
  } else {
    const today = startOfLocalDay(now)
    const days = Math.max(1, definition.days)
    for (let index = days - 1; index >= 0; index -= 1) starts.push(today - index * DAY_MS)
  }

  const from = starts.length > 0 ? starts[0] : now
  const labels = starts.map((t) => formatBucketLabel(t, granularity))
  const indexByStart = new Map()
  for (let index = 0; index < starts.length; index += 1) indexByStart.set(starts[index], index)

  /** 把「小时桶键」映射到时间轴下标；不在范围内返回 -1。 */
  function indexFor(hourKey) {
    const time = safeNumber(hourKey)
    if (time <= 0) return -1
    if (granularity === 'hour') {
      const index = Math.floor((time - from) / HOUR_MS)
      return index >= 0 && index < starts.length ? index : -1
    }
    const dayStart = startOfLocalDay(time)
    const bucketStart = granularity === 'week' ? startOfLocalWeek(dayStart) : dayStart
    const index = indexByStart.get(bucketStart)
    return index === undefined ? -1 : index
  }

  return { key: normalized, from, to: now, label: definition.label, granularity, starts, labels, indexFor }
}

/** @returns {number | null} 全库最早活动时间。 */
function earliestActivity(entryMap) {
  let earliest = null
  for (const entry of entryMap.values()) {
    const candidate = entry.stats.firstEventAt ?? entry.stats.createdAt ?? null
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue
    if (earliest === null || candidate < earliest) earliest = candidate
  }
  return earliest
}

// ─── token / 时间轴聚合 ──────────────────────────────────────────────────────

/** 把五个 token 字段加到目标对象上。 */
function addTokens(target, source) {
  for (const field of TOKEN_FIELDS) target[field] = safeNumber(target[field]) + safeNumber(source[field])
}

/** 新建时间轴桶（比 fold 的 HourBucket 多一个 sessions 集合用于按桶计会话数）。 */
function emptyTimelineBucket(t, label) {
  return {
    t,
    label,
    ...emptyTokenBucket(),
    requests: 0,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    errorTurns: 0,
    interruptedTurns: 0,
    llmMs: 0,
    toolMs: 0,
    sessions: new Set(),
    /** @type {Map<string, { uncachedInputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number, reasoningTokens: number, requests: number }>} */
    byModel: new Map(),
  }
}

/** 把一个 fold HourBucket 累加进时间轴桶。 */
function accumulateHourBucket(target, hour, sessionId) {
  addTokens(target, hour)
  target.costCNY = safeNumber(target.costCNY) + safeNumber(hour.costCNY)
  target.requests += safeNumber(hour.requests)
  target.turns += safeNumber(hour.turns)
  target.steps += safeNumber(hour.steps)
  target.toolCalls += safeNumber(hour.toolCalls)
  target.errorTurns += safeNumber(hour.errorTurns)
  target.interruptedTurns += safeNumber(hour.interruptedTurns)
  target.llmMs += safeNumber(hour.llmMs)
  target.toolMs += safeNumber(hour.toolMs)
  if (typeof sessionId === 'string' && sessionId !== '') target.sessions.add(sessionId)
  if (hour.byModel instanceof Map) {
    for (const [modelKey, modelBucket] of hour.byModel) {
      let total = target.byModel.get(modelKey)
      if (!total) {
        total = { ...emptyTokenBucket(), requests: 0 }
        target.byModel.set(modelKey, total)
      }
      addTokens(total, modelBucket)
      total.costCNY = safeNumber(total.costCNY) + safeNumber(modelBucket.costCNY)
      total.requests += safeNumber(modelBucket.requests)
    }
  }
}

/** @returns {number[]} 只保留时间落在 [from, to] 内的样本。 */
function filterSamplesByTime(samples, times, from, to) {
  const values = []
  const count = Math.min(samples.length, times.length)
  for (let index = 0; index < count; index += 1) {
    const time = times[index]
    if (typeof time !== 'number' || !Number.isFinite(time) || time < from || time > to) continue
    const value = samples[index]
    if (typeof value === 'number' && Number.isFinite(value)) values.push(value)
  }
  return values
}

/** 均值（空数组 → 0）。 */
function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0
  let sum = 0
  for (const value of values) sum += safeNumber(value)
  const result = sum / values.length
  return Number.isFinite(result) ? result : 0
}

/** 百分位统计 { avg, p50, p90, samples }。 */
function percentileStats(values) {
  if (!Array.isArray(values) || values.length === 0) return { avg: 0, p50: 0, p90: 0, samples: 0 }
  const sorted = [...values].sort((left, right) => left - right)
  const quantile = (q) => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))
    return safeNumber(sorted[index])
  }
  return { avg: average(sorted), p50: quantile(0.5), p90: quantile(0.9), samples: sorted.length }
}

/**
 * 把一个会话裁剪到 range 内：token / 计数 / 成本 / 时序样本 / 模型名。
 * @param {object} stats
 * @param {{ from: number, to: number, indexFor: (hourKey: number) => number }} spec
 * @param {Record<string, object>} table
 */
function clipSessionStats(stats, spec, table) {
  const tokens = emptyTokenBucket()
  let requests = 0
  let turns = 0
  let steps = 0
  let toolCalls = 0
  let costCNY = 0
  let llmMs = 0
  let toolMs = 0
  let errorTurns = 0
  let interruptedTurns = 0
  const modelNames = new Set()

  const hours = stats.hours instanceof Map ? stats.hours.values() : []
  for (const hour of hours) {
    if (spec.indexFor(hour.t) < 0) continue
    addTokens(tokens, hour)
    requests += safeNumber(hour.requests)
    turns += safeNumber(hour.turns)
    steps += safeNumber(hour.steps)
    toolCalls += safeNumber(hour.toolCalls)
    llmMs += safeNumber(hour.llmMs)
    toolMs += safeNumber(hour.toolMs)
    errorTurns += safeNumber(hour.errorTurns)
    interruptedTurns += safeNumber(hour.interruptedTurns)
    costCNY += safeNumber(hour.costCNY)
    if (hour.byModel instanceof Map) {
      for (const modelKey of hour.byModel.keys()) modelNames.add(splitModelKey(modelKey).model)
    }
  }

  const ttftValues = filterSamplesByTime(stats.ttftSamples, stats.ttftSampleTimes, spec.from, spec.to)
  const tpsValues = filterSamplesByTime(stats.tpsSamples, stats.tpsSampleTimes, spec.from, spec.to)
  return {
    tokens,
    requests,
    turns,
    steps,
    toolCalls,
    costCNY,
    llmMs,
    toolMs,
    errorTurns,
    interruptedTurns,
    ttftValues,
    tpsValues,
    modelNames: [...modelNames].sort(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 采集器
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} ctx Host context（需要 ctx.sessionQuery / ctx.webServer / ctx.on）
 * @param {object} [config] 插件配置（契约 §5；未提供的 key 用默认值）
 */
export function createCollector(ctx, config, deps) {
  const settings = normalizeConfig(config)
  const table = pricingTable(settings)
  // v5：有效节假日集合 = 内置 2025/2026 + config.pricingHolidays 追加项（只读，不搞模块级可变全局）。
  const holidaySet = holidaySetOf(settings.pricingHolidays)
  const startedAt = Date.now()

  // v4：实时汇率（可选依赖；缺省时行为与旧版完全一致）。
  // 只用于 `costUSD = costCNY / fxRate` 的派生展示与 `fx` 元数据；CNY 金额是权威值，
  // **绝不用**实时汇率重算历史成本（否则历史金额会随汇率漂移，契约 §7.9）。
  const fxSource = deps && typeof deps === 'object' ? deps.fxRate : null
  const FX_FALLBACK_LABEL = '配置兜底值（离线/获取失败）'

  /** 同步读取实时汇率视图（绝不抛；服务不可用/异常 → null）。 */
  function currentFxView() {
    try {
      const view = fxSource && typeof fxSource.getRate === 'function' ? fxSource.getRate() : null
      if (view && typeof view === 'object' && Number.isFinite(Number(view.rate)) && Number(view.rate) > 0) {
        return view
      }
    } catch {
      // 汇率服务异常不应影响用量统计。
    }
    return null
  }

  /** 当前生效的 USD→CNY 汇率：实时值优先，否则配置兜底值。 */
  function currentFxRate() {
    const view = currentFxView()
    return view ? Number(view.rate) : settings.usdCnyRate
  }

  /** 契约 §2.1 / §7.9 的 `fx` 元数据块。 */
  function fxMeta(fxRate) {
    const view = currentFxView()
    return {
      baseCurrency: PRICING_BASE_CURRENCY,
      usdCnyRate: fxRate,
      source: view && typeof view.source === 'string' ? view.source : 'config',
      sourceLabel: view && typeof view.sourceLabel === 'string' ? view.sourceLabel : FX_FALLBACK_LABEL,
      effectiveDate: view && typeof view.effectiveDate === 'string' ? view.effectiveDate : null,
      fetchedAt: view && Number.isFinite(Number(view.fetchedAt)) ? Number(view.fetchedAt) : 0,
      stale: view ? view.stale === true : true,
    }
  }

  /** @type {Map<string, Entry>} */
  const entries = new Map()
  /** @type {{ sessionsTotal: number, sessionsInRange: number, scanned: number, cached: number, errors: number, scanning: boolean, lastScanAt: number }} */
  const scanState = {
    sessionsTotal: 0,
    sessionsInRange: 0,
    scanned: 0,
    cached: 0,
    errors: 0,
    scanning: false,
    lastScanAt: 0,
  }

  /** 最近 60s 的活跃窗口：{ at, outputTokens, requests }。 */
  const recent = []
  /** tokensPerMin 环形缓冲（getLive 时按采样周期推进）。 */
  const tokensPerMinHistory = []
  let lastTokensPerMinPushAt = 0

  /** @type {string | null} 正在等待去抖重建的会话 id */
  const pendingRescans = new Set()

  const disposers = []
  const sampler = createSystemSampler(settings.sampleIntervalMs, settings.liveHistoryPoints)

  let disposed = false
  let started = false
  /** @type {Promise<void> | null} */
  let scanPromise = null
  /** @type {ReturnType<typeof setInterval> | null} */
  let rescanTimer = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let cacheTimer = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let rescanFlushTimer = null

  /** Host 日志（失败静默，绝不影响采集）。 */
  function logWarn(message, error) {
    try {
      if (!ctx || typeof ctx.logger !== 'function') return
      const logger = ctx.logger('usage-monitor')
      if (!logger) return
      const detail = error instanceof Error ? error.message : error
      if (typeof logger.warn === 'function') logger.warn(message, detail)
      else if (typeof logger.debug === 'function') logger.debug(message, detail)
    } catch {
      // 忽略日志失败
    }
  }

  // ── 读取单个会话 ──────────────────────────────────────────────────────────

  /** 创建一个 20s 超时的 AbortSignal（拿不到就返回 undefined）。 */
  function createTimeoutSignal() {
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(SESSION_READ_TIMEOUT_MS)
      }
    } catch {
      // 忽略
    }
    return undefined
  }

  /** 释放 observation lease（不同版本可能是 dispose() 或 [Symbol.dispose]）。 */
  function disposeObservation(observation) {
    if (!observation || (typeof observation !== 'object' && typeof observation !== 'function')) return
    try {
      if (typeof observation.dispose === 'function') observation.dispose()
      else if (typeof observation[Symbol.dispose] === 'function') observation[Symbol.dispose]()
    } catch {
      // 忽略释放失败
    }
  }

  /**
   * 用 sessionQuery.observeSession 冷读一个会话并折叠成 SessionStats。
   * @returns {Promise<{ header: object | null, stats: object, revision: string | null } | null>}
   */
  async function readSessionStats(sessionId) {
    const query = ctx && typeof ctx === 'object' ? ctx.sessionQuery : null
    if (!query || typeof query.observeSession !== 'function') {
      throw new Error('ctx.sessionQuery.observeSession is unavailable')
    }
    const observation = await query.observeSession(sessionId, {
      projectionMode: 'none',
      signal: createTimeoutSignal(),
    })
    try {
      const header = observation && typeof observation.header === 'object' ? observation.header : null
      const stats = emptySessionStats(header, table, holidaySet)
      if (!stats.id) stats.id = sessionId
      const events = observation && Array.isArray(observation.events) ? observation.events : []
      foldEvents(stats, events)
      const revision =
        observation && (typeof observation.revision === 'string' || typeof observation.revision === 'number')
          ? String(observation.revision)
          : null
      return { header, stats, revision }
    } finally {
      disposeObservation(observation)
    }
  }

  // ── 扫描 ─────────────────────────────────────────────────────────────────

  /** 扫描/复查单个会话。已有可用缓存时只计数，不冷读。 */
  async function scanSession(record) {
    if (disposed || !record || typeof record !== 'object') return
    const header = record.header && typeof record.header === 'object' ? record.header : null
    const id = header && typeof header.id === 'string' ? header.id : null
    if (!id) return
    const live = record.live === true
    const existing = entries.get(id)
    if (existing) {
      const wasLive = existing.live === true
      existing.live = live
      // 是否必须重读日志：
      //  - 标记了 needsRescan（seq 断档/重建失败）
      //  - 从非 live 变 live（会话重新开始，日志必然继续增长）
      //  - 来自落盘缓存且缓存时是 live（离线期间可能还有事件没收进来）
      const mustRead =
        existing.needsRescan === true || (!wasLive && live) || (existing.source === 'cache' && wasLive)
      if (!mustRead) {
        // 已折叠过（或缓存里是已结束会话，日志不会再增长）→ 直接复用缓存，不冷读。
        scanState.cached += 1
        return
      }
    }
    try {
      const result = await readSessionStats(id)
      if (!result) return
      entries.set(id, {
        id,
        revision: result.revision,
        live,
        stats: result.stats,
        scannedAt: Date.now(),
        source: 'scan',
        needsRescan: false,
        rebuilding: false,
        pendingEvents: [],
      })
      scanState.scanned = entries.size
    } catch (error) {
      scanState.errors += 1
      logWarn(`读取会话失败: ${id}`, error)
    }
  }

  /**
   * 全库扫描：listSessions 对账 + 分片冷读 + 修剪已删除会话。
   * 单实例串行（scanPromise 去重），每 SCAN_CHUNK_SIZE 个会话让出一次事件循环。
   */
  function runScan() {
    if (disposed) return Promise.resolve()
    if (scanPromise) return scanPromise
    scanPromise = (async () => {
      scanState.scanning = true
      scanState.lastScanAt = Date.now()
      scanState.cached = 0
      try {
        const query = ctx && typeof ctx === 'object' ? ctx.sessionQuery : null
        let records = []
        let listed = false
        if (query && typeof query.listSessions === 'function') {
          const result = await query.listSessions()
          if (Array.isArray(result)) {
            records = result
            listed = true
          }
        } else {
          scanState.errors += 1
          logWarn('ctx.sessionQuery.listSessions 不可用', null)
        }
        if (listed) scanState.sessionsTotal = records.length

        const seen = new Set()
        for (let index = 0; index < records.length; index += SCAN_CHUNK_SIZE) {
          if (disposed) break
          const chunk = records.slice(index, index + SCAN_CHUNK_SIZE)
          for (const record of chunk) {
            const id = record && record.header && typeof record.header.id === 'string' ? record.header.id : null
            if (id) seen.add(id)
            await scanSession(record)
          }
          await yieldToEventLoop()
        }

        // 只修剪「清单里确实没有」的会话；listSessions 失败时不修剪，避免误删缓存。
        if (listed) {
          for (const id of [...entries.keys()]) {
            if (!seen.has(id)) entries.delete(id)
          }
        }
        scanState.scanned = entries.size
        scheduleCacheSave()
      } catch (error) {
        scanState.errors += 1
        logWarn('全库扫描失败', error)
      } finally {
        scanState.scanning = false
        scanPromise = null
      }
    })()
    return scanPromise
  }

  // ── live 增量 ────────────────────────────────────────────────────────────

  /** 从监听器参数里取会话 id。 */
  function sessionIdOf(session, event) {
    const candidates = [
      session && typeof session === 'object' ? session.id : null,
      session && session.header && typeof session.header === 'object' ? session.header.id : null,
      event && typeof event === 'object' ? event.sessionId : null,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate !== '') return candidate
    }
    return null
  }

  /** 记录最近 60s 活跃窗口（只关心 assistant/message 的 outputTokens）。 */
  function accountRecent(event) {
    if (!event || event.type !== 'assistant/message') return
    const data = event.data && typeof event.data === 'object' ? event.data : null
    const usage = data && data.usage && typeof data.usage === 'object' ? data.usage : null
    const at = safeNumber(event.time) || Date.now()
    recent.push({ at, outputTokens: safeNumber(usage ? usage.outputTokens : 0), requests: 1 })
    pruneRecent(at)
  }

  /** 修剪 60s 窗口。 */
  function pruneRecent(now) {
    const cutoff = (typeof now === 'number' && Number.isFinite(now) ? now : Date.now()) - RECENT_WINDOW_MS
    while (recent.length > 0 && recent[0].at < cutoff) recent.shift()
  }

  /** 最近 60s 的输出 token 与请求数（tokensPerMin 已是「每分钟」口径）。 */
  function recentWindow() {
    const now = Date.now()
    pruneRecent(now)
    let outputTokens = 0
    let requests = 0
    for (const item of recent) {
      outputTokens += item.outputTokens
      requests += item.requests
    }
    return { tokensPerMin: outputTokens, requestsPerMin: requests }
  }

  /** 安排一次单会话去抖重建（seq 断档 / 未知会话）。 */
  function scheduleRescan(sessionId) {
    if (disposed || typeof sessionId !== 'string' || sessionId === '') return
    pendingRescans.add(sessionId)
    if (rescanFlushTimer !== null) return
    rescanFlushTimer = setTimeout(() => {
      rescanFlushTimer = null
      void flushRescans()
    }, RESCAN_DEBOUNCE_MS)
    if (rescanFlushTimer && typeof rescanFlushTimer.unref === 'function') rescanFlushTimer.unref()
  }

  /** 执行待重建队列：只重建单个会话，绝不整库重扫。 */
  async function flushRescans() {
    if (disposed) return
    const ids = [...pendingRescans]
    pendingRescans.clear()
    for (const id of ids) {
      if (disposed) break
      const entry = entries.get(id)
      if (!entry) continue // 初始扫描会覆盖它，无需单独重建
      entry.rebuilding = true
      entry.pendingEvents = []
      try {
        const result = await readSessionStats(id)
        const current = entries.get(id)
        if (result && current) {
          const rebuilt = {
            id,
            revision: result.revision,
            live: current.live,
            stats: result.stats,
            scannedAt: Date.now(),
            source: 'scan',
            needsRescan: false,
            rebuilding: false,
            pendingEvents: [],
          }
          entries.set(id, rebuilt)
          // 重建期间到达的事件补折进新统计（seq 连续才折，否则再排一次重建）。
          for (const event of current.pendingEvents) {
            const seq = safeNumber(event.seq)
            if (seq > 0 && rebuilt.stats.lastSeq >= 0 && seq !== rebuilt.stats.lastSeq + 1) {
              rebuilt.needsRescan = true
              break
            }
            foldEvent(rebuilt.stats, event)
          }
          if (rebuilt.needsRescan) scheduleRescan(id)
        }
      } catch (error) {
        scanState.errors += 1
        logWarn(`重建会话失败: ${id}`, error)
        const current = entries.get(id)
        if (current) current.rebuilding = false
      }
      await yieldToEventLoop()
    }
    scheduleCacheSave()
  }

  /** `session/event` 监听器：把新事件增量折叠进缓存。 */
  function handleSessionEvent(session, event) {
    if (disposed || !event || typeof event !== 'object') return
    const sessionId = sessionIdOf(session, event)
    if (sessionId === null) return
    accountRecent(event)

    const entry = entries.get(sessionId)
    if (!entry) {
      // 初始扫描还没覆盖到（或会话是在扫描后新建的）：安排重建。
      scheduleRescan(sessionId)
      return
    }
    if (entry.rebuilding) {
      entry.pendingEvents.push(event)
      return
    }

    const seq = safeNumber(event.seq)
    if (seq > 0 && entry.stats.lastSeq >= 0 && seq !== entry.stats.lastSeq + 1) {
      // 事件 seq 断档（可能本插件中途挂载、或事件被过滤）：单会话重建。
      entry.needsRescan = true
      scheduleRescan(sessionId)
      return
    }
    foldEvent(entry.stats, event)
    entry.live = true
    entry.source = 'live'
    entry.revision = null
    scheduleCacheSave()
  }

  // ── 落盘缓存 ─────────────────────────────────────────────────────────────

  /** 读回落盘缓存（start 时调用；构造期不允许 IO）。 */
  function loadCacheFile() {
    if (!settings.cacheFile) return
    let text = null
    try {
      text = readFileSync(settings.cacheFile, 'utf8')
    } catch {
      return // 首次运行：没有缓存文件是正常的
    }
    try {
      const payload = JSON.parse(text)
      if (!payload || payload.version !== CACHE_VERSION || !Array.isArray(payload.entries)) return
      for (const raw of payload.entries) {
        if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') continue
        const stats = reviveSessionStats(raw.stats, table, holidaySet)
        if (!stats) continue
        entries.set(raw.id, {
          id: raw.id,
          revision: typeof raw.revision === 'string' ? raw.revision : null,
          live: false, // live 标记不信任磁盘快照，扫描时由 listSessions 刷新
          stats,
          scannedAt: safeNumber(raw.scannedAt),
          source: 'cache',
          needsRescan: false,
          rebuilding: false,
          pendingEvents: [],
        })
      }
      scanState.scanned = entries.size
    } catch {
      // 缓存损坏：直接丢弃，按无缓存处理
    }
  }

  /** 落盘缓存（去抖）。 */
  function scheduleCacheSave() {
    if (disposed || !settings.cacheFile || cacheTimer !== null) return
    cacheTimer = setTimeout(() => {
      cacheTimer = null
      saveCacheFile()
    }, CACHE_SAVE_DELAY_MS)
    if (cacheTimer && typeof cacheTimer.unref === 'function') cacheTimer.unref()
  }

  /** 原子写缓存文件：先写 .tmp，再 rename 覆盖。失败静默（缓存只是加速）。 */
  function saveCacheFile() {
    if (!settings.cacheFile) return
    try {
      const payload = { version: CACHE_VERSION, savedAt: Date.now(), entries: [] }
      for (const entry of entries.values()) {
        const stats = serializeSessionStats(entry.stats)
        if (!stats) continue
        payload.entries.push({
          id: entry.id,
          revision: entry.revision,
          live: entry.live === true,
          scannedAt: entry.scannedAt,
          stats,
        })
      }
      const directory = path.dirname(settings.cacheFile)
      mkdirSync(directory, { recursive: true })
      const temporary = `${settings.cacheFile}.tmp`
      writeFileSync(temporary, JSON.stringify(payload), 'utf8')
      renameSync(temporary, settings.cacheFile)
    } catch (error) {
      logWarn('写入缓存文件失败', error)
    }
  }

  // ── live 视图 ────────────────────────────────────────────────────────────

  /** 把数组补齐到 liveHistoryPoints 个点（前端 sparkline 需要固定长度）。 */
  function padHistory(source) {
    const points = settings.liveHistoryPoints
    const list = Array.isArray(source) ? source.map(safeNumber) : []
    if (list.length >= points) return list.slice(list.length - points)
    return new Array(points - list.length).fill(0).concat(list)
  }

  /** tokensPerMin 环形缓冲按采样周期推进（前 1 分钟自然为 0）。 */
  function pushTokensPerMin(value) {
    const now = Date.now()
    const minGap = Math.max(250, Math.floor(settings.sampleIntervalMs * 0.5))
    if (lastTokensPerMinPushAt !== 0 && now - lastTokensPerMinPushAt < minGap) return
    lastTokensPerMinPushAt = now
    tokensPerMinHistory.push(safeNumber(value))
    if (tokensPerMinHistory.length > settings.liveHistoryPoints) {
      tokensPerMinHistory.splice(0, tokensPerMinHistory.length - settings.liveHistoryPoints)
    }
  }

  /** 契约 §2.2 全时段 counters。 */
  function buildCounters() {
    let totalTokens = 0
    let uncachedInputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let costCNY = 0
    let activeSessions = 0
    for (const entry of entries.values()) {
      const stats = entry.stats
      totalTokens += sumTokens(stats)
      uncachedInputTokens += safeNumber(stats.uncachedInputTokens)
      cacheReadTokens += safeNumber(stats.cacheReadTokens)
      cacheWriteTokens += safeNumber(stats.cacheWriteTokens)
      costCNY += safeNumber(stats.costCNY)
      if (entry.live === true) activeSessions += 1
    }
    return {
      sessionsTotal: entries.size,
      activeSessions,
      totalTokens,
      cacheHitRate: cacheHitRateOf({ uncachedInputTokens, cacheReadTokens, cacheWriteTokens }),
      costCNY,
      costUSD: cnyToUsd(costCNY, currentFxRate()),
      ...recentWindow(),
    }
  }

  // ── overview 组装 ────────────────────────────────────────────────────────

  /** 组装契约 §2.1 的 overview（纯计算，同步）。 */
  function buildOverview(entryMap, options) {
    const now = Date.now()
    const requestedRange = options && typeof options.range === 'string' ? options.range : '24h'
    // 币种语义（v3.1）：成本以 **CNY** 为权威基准；USD 只是 cny / fxRate 的派生展示。
    // currency 缺省/非法 → CNY（契约 §2.1）。
    const currency = options && options.currency === 'USD' ? 'USD' : 'CNY'
    // v4：汇率优先取实时央行中间价（collect 由 `deps.fxRate` 注入），否则配置兜底值。
    const fxRate = currentFxRate()
    const toUSD = (cny) => cnyToUsd(cny, fxRate)
    const convert = (cny) => (currency === 'CNY' ? safeNumber(cny) : toUSD(cny))

    const spec = resolveRange(requestedRange, now, earliestActivity(entryMap))
    const timeline = spec.starts.map((t, index) => emptyTimelineBucket(t, spec.labels[index]))
    /** @type {Map<string, ReturnType<typeof emptyTokenBucket> & { requests: number }>} */
    const modelTotals = new Map()
    /** @type {number[]} */
    const allTtft = []
    /** @type {number[]} */
    const allTps = []
    const sessionRows = []
    let activeSessions = 0

    for (const entry of entryMap.values()) {
      const stats = entry.stats
      if (entry.live === true) activeSessions += 1

      for (const hour of stats.hours.values()) {
        const index = spec.indexFor(hour.t)
        if (index < 0) continue
        const bucket = timeline[index]
        accumulateHourBucket(bucket, hour, entry.id)
        for (const [modelKey, modelBucket] of hour.byModel) {
          let total = modelTotals.get(modelKey)
          if (!total) {
            total = { ...emptyTokenBucket(), requests: 0 }
            modelTotals.set(modelKey, total)
          }
          addTokens(total, modelBucket)
          total.costCNY = safeNumber(total.costCNY) + safeNumber(modelBucket.costCNY)
          total.requests += safeNumber(modelBucket.requests)
        }
      }

      const lastSeen = safeNumber(stats.lastActivityAt ?? stats.createdAt ?? 0)
      if (lastSeen < spec.from && spec.key !== 'all') continue

      const clipped = clipSessionStats(stats, spec, table)
      allTtft.push(...clipped.ttftValues)
      allTps.push(...clipped.tpsValues)
      const totalTokens = sumTokens(clipped.tokens)
      sessionRows.push({
        id: stats.id,
        title: typeof stats.title === 'string' ? stats.title : '',
        cwd: typeof stats.cwd === 'string' ? stats.cwd : null,
        createdAt: stats.createdAt === null ? 0 : safeNumber(stats.createdAt),
        lastActivityAt: stats.lastActivityAt === null ? 0 : safeNumber(stats.lastActivityAt),
        live: entry.live === true,
        turns: clipped.turns,
        steps: clipped.steps,
        requests: clipped.requests,
        toolCalls: clipped.toolCalls,
        ...clipped.tokens,
        totalTokens,
        cost: convert(clipped.costCNY),
        costCNY: clipped.costCNY,
        costUSD: toUSD(clipped.costCNY),
        cacheHitRate: cacheHitRateOf(clipped.tokens),
        avgTtftMs: average(clipped.ttftValues),
        tokensPerSec: average(clipped.tpsValues),
        models: clipped.modelNames,
        agentPreset: typeof stats.agentPreset === 'string' ? stats.agentPreset : null,
        parentSession: typeof stats.parentSession === 'string' ? stats.parentSession : null,
        origin: typeof stats.origin === 'string' ? stats.origin : null,
        delegationDepth: safeNumber(stats.delegationDepth),
      })
    }

    sessionRows.sort((left, right) => right.lastActivityAt - left.lastActivityAt)

    // ── KPI 合计（全部由时间轴桶累加，保证与 series 同源）──
    const totals = emptyTokenBucket()
    let requests = 0
    let turns = 0
    let steps = 0
    let toolCalls = 0
    let errorTurns = 0
    let interruptedTurns = 0
    let llmMs = 0
    let toolMs = 0
    let costCNY = 0
    for (const bucket of timeline) {
      addTokens(totals, bucket)
      requests += bucket.requests
      turns += bucket.turns
      steps += bucket.steps
      toolCalls += bucket.toolCalls
      errorTurns += bucket.errorTurns
      interruptedTurns += bucket.interruptedTurns
      llmMs += bucket.llmMs
      toolMs += bucket.toolMs
      costCNY += safeNumber(bucket.costCNY)
    }
    const totalTokens = sumTokens(totals)
    const cacheHitRate = cacheHitRateOf(totals)
    const sessionsInRange = sessionRows.length

    // ── models 表：token/请求/成本按 range 裁剪；时序指标取全时段（模型级样本未按时间存储）──
    const modelRows = []
    for (const [modelKey, modelBucket] of modelTotals) {
      const { provider, model } = splitModelKey(modelKey)
      const price = priceFor(model, table)
      const modelCostCNY = safeNumber(modelBucket.costCNY)
      let ttftMs = 0
      let ttftCount = 0
      let decodeMs = 0
      let decodeTokens = 0
      for (const entry of entryMap.values()) {
        const modelStats = entry.stats.models.get(modelKey)
        if (!modelStats) continue
        ttftMs += safeNumber(modelStats.ttftMs)
        ttftCount += safeNumber(modelStats.ttftCount)
        decodeMs += safeNumber(modelStats.decodeMs)
        decodeTokens += safeNumber(modelStats.decodeTokens)
      }
      modelRows.push({
        provider,
        model,
        requests: safeNumber(modelBucket.requests),
        totalTokens: sumTokens(modelBucket),
        ...modelBucket,
        cost: convert(modelCostCNY),
        costCNY: modelCostCNY,
        costUSD: toUSD(modelCostCNY),
        cacheHitRate: cacheHitRateOf(modelBucket),
        avgTtftMs: ttftCount > 0 ? ttftMs / ttftCount : 0,
        tokensPerSec: decodeMs > 0 ? decodeTokens / (decodeMs / 1000) : 0,
        priced: price !== null,
      })
    }
    modelRows.sort((left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests)

    return {
      generatedAt: now,
      range: { key: spec.key, from: spec.from, to: spec.to, label: spec.label },
      fx: fxMeta(fxRate),
      scan: {
        sessionsTotal: scanState.sessionsTotal > 0 ? scanState.sessionsTotal : entryMap.size,
        sessionsInRange,
        scanned: entryMap.size,
        cached: scanState.cached,
        errors: scanState.errors,
        scanning: scanState.scanning === true,
        lastScanAt: scanState.lastScanAt,
      },
      kpi: {
        totalTokens,
        ...totals,
        cacheHitRate,
        cost: convert(costCNY),
        costCNY,
        costUSD: toUSD(costCNY),
        currency,
        fxRate,
        sessions: sessionsInRange,
        activeSessions,
        turns,
        steps,
        requests,
        toolCalls,
        avgTokensPerSession: sessionsInRange > 0 ? totalTokens / sessionsInRange : 0,
        avgTokensPerTurn: turns > 0 ? totalTokens / turns : 0,
        avgTtftMs: average(allTtft),
        tokensPerSec: average(allTps),
        tokensPerMin: recentWindow().tokensPerMin,
      },
      series: {
        granularity: spec.granularity,
        buckets: timeline.map((bucket) => ({
          t: bucket.t,
          label: bucket.label,
          ...bucketSerializableTokens(bucket),
          totalTokens: sumTokens(bucket),
          cost: convert(bucket.costCNY),
          costCNY: bucket.costCNY,
          costUSD: toUSD(bucket.costCNY),
          sessions: bucket.sessions.size,
          requests: bucket.requests,
        })),
      },
      models: modelRows,
      sessions: sessionRows,
      performance: {
        ttft: percentileStats(allTtft),
        tokensPerSec: percentileStats(allTps),
        toolMs,
        llmMs,
        toolShare: llmMs + toolMs > 0 ? toolMs / (llmMs + toolMs) : 0,
        cacheHitRate,
        requestsPerTurn: turns > 0 ? requests / turns : 0,
        toolCallsPerTurn: turns > 0 ? toolCalls / turns : 0,
        errorTurns,
        interruptedTurns,
        totalTurns: turns,
      },
      pricing: pricingInfo(settings),
    }
  }

  /** 只取 token 五个字段（避免把 requests/sessions 等内部字段带进 series）。 */
  function bucketSerializableTokens(bucket) {
    const tokens = {}
    for (const field of TOKEN_FIELDS) tokens[field] = safeNumber(bucket[field])
    return tokens
  }

  // ── 对外 API ─────────────────────────────────────────────────────────────

  /**
   * 契约 §2.1。异步返回，但计算是同步的（<300ms 目标）；任何异常都降级为空数据而非 500。
   * @param {{ range?: string, currency?: string }} [options]
   */
  async function getOverview(options) {
    const safeOptions = options && typeof options === 'object' ? options : {}
    try {
      return buildOverview(entries, safeOptions)
    } catch (error) {
      logWarn('overview 组装失败', error)
      try {
        return buildOverview(new Map(), safeOptions)
      } catch {
        return {
          generatedAt: Date.now(),
          range: { key: '24h', from: Date.now(), to: Date.now(), label: RANGE_DEFS['24h'].label },
          scan: { ...scanState, scanned: entries.size },
          kpi: {},
          series: { granularity: 'hour', buckets: [] },
          models: [],
          sessions: [],
          performance: {},
          pricing: pricingInfo(settings),
        }
      }
    }
  }

  /**
   * 契约 §2.2：同步、非阻塞、不做 IO（GPU 值来自采样器缓存）。
   * @returns {object}
   */
  function getLive() {
    try {
      const system = sampler.sample()
      const window = recentWindow()
      pushTokensPerMin(window.tokensPerMin)
      const counters = buildCounters()
      return {
        generatedAt: Date.now(),
        uptime: { processMs: Date.now() - startedAt, hostMs: Math.round(safeNumber(os.uptime()) * 1000) },
        process: { ...system.process },
        host: { ...system.host },
        gpu: { ...system.gpu },
        counters,
        history: {
          cpu: padHistory(sampler.history.cpu),
          gpu: padHistory(sampler.history.gpu),
          mem: padHistory(sampler.history.mem),
          tokensPerMin: padHistory(tokensPerMinHistory),
        },
      }
    } catch (error) {
      logWarn('live 采样失败', error)
      return {
        generatedAt: Date.now(),
        uptime: { processMs: Date.now() - startedAt, hostMs: 0 },
        process: { pid: safeNumber(process.pid), cpuPercent: 0, rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0, threads: 0 },
        host: { cpuPercent: 0, cores: 0, loadAvg: [0, 0, 0], memUsedBytes: 0, memTotalBytes: 0, memPercent: 0, freeMemBytes: 0 },
        gpu: {
          available: false,
          name: null,
          utilPercent: 0,
          memUsedBytes: 0,
          memTotalBytes: 0,
          memPercent: 0,
          tempC: 0,
          powerW: 0,
        },
        counters: { ...buildCounters() },
        history: { cpu: padHistory([]), gpu: padHistory([]), mem: padHistory([]), tokensPerMin: padHistory([]) },
      }
    }
  }

  /**
   * 作废缓存：传会话 id 只作废该会话；不传则全部作废（下次扫描/事件触发重建）。
   * @param {string} [sessionId]
   */
  function invalidate(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') {
      entries.delete(sessionId)
      pendingRescans.delete(sessionId)
    } else {
      entries.clear()
      recent.length = 0
    }
    scanState.scanned = entries.size
    scheduleCacheSave()
  }

  /** 启动：读缓存、挂监听、起后台扫描与重扫定时器。 */
  function start() {
    if (started || disposed) return
    started = true
    loadCacheFile()
    attachListeners()
    void runScan()
    rescanTimer = setInterval(() => {
      void runScan()
    }, settings.rescanIntervalMs)
    if (rescanTimer && typeof rescanTimer.unref === 'function') rescanTimer.unref()
  }

  /** 挂 session/event 监听（cordis 的 ctx.on 返回 disposer）。 */
  function attachListeners() {
    if (!ctx || typeof ctx.on !== 'function') return
    try {
      const off = ctx.on('session/event', handleSessionEvent)
      if (typeof off === 'function') disposers.push(off)
      const offDispose = ctx.on('dispose', () => {
        dispose()
      })
      if (typeof offDispose === 'function') disposers.push(offDispose)
    } catch (error) {
      logWarn('挂载 session/event 监听失败', error)
    }
  }

  /** 释放：幂等；停定时器、摘监听、落一次缓存。 */
  function dispose() {
    if (disposed) return
    disposed = true
    if (rescanTimer !== null) {
      clearInterval(rescanTimer)
      rescanTimer = null
    }
    if (cacheTimer !== null) {
      clearTimeout(cacheTimer)
      cacheTimer = null
    }
    if (rescanFlushTimer !== null) {
      clearTimeout(rescanFlushTimer)
      rescanFlushTimer = null
    }
    while (disposers.length > 0) {
      const off = disposers.pop()
      try {
        if (typeof off === 'function') off()
      } catch {
        // 忽略
      }
    }
    try {
      saveCacheFile()
    } catch {
      // 忽略
    }
    try {
      sampler.dispose()
    } catch {
      // 忽略
    }
  }

  return { getOverview, getLive, invalidate, start, dispose }
}

/**
 * @typedef {Object} Entry
 * @property {string} id
 * @property {string | null} revision
 * @property {boolean} live
 * @property {object} stats SessionStats（来自 lib/fold.js）
 * @property {number} scannedAt
 * @property {'scan' | 'live' | 'cache'} source
 * @property {boolean} needsRescan
 * @property {boolean} rebuilding
 * @property {object[]} pendingEvents
 */
