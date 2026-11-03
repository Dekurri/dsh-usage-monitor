/**
 * dsh-usage-monitor — 全量模型调用账本（Host 侧，契约 §7.1）。
 *
 * 为什么需要它：会话日志（`assistant/message`）只记录主对话链路，
 * **漏掉** Auto review、会话标题、上下文压缩、联网搜索等辅助调用。
 * 这些调用全部经过 Host 的 `llm/stream` waterfall，本模块挂在同一条
 * waterfall 上做无损旁路：原样转发每一个 chunk（绝不缓冲到流结束才发），
 * 顺带捕获 `{ type: 'usage' }` 并写成按小时聚合的账本。
 *
 * 契约要点（CONTRACT.md §7.1）：
 *   export function createLlmLedger(ctx, options) -> {
 *     snapshot({ range }): LedgerView,   // 契约 §7.3，同步返回
 *     flush(): Promise<void>,            // 立即落盘
 *     start(): void,
 *     dispose(): void,                   // 幂等
 *   }
 * - 拦截方式：`ctx.on('llm/stream', (callOptions, next) => wrapped)`，
 *   事件签名 `'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>)`
 *   （cordis waterfall：listener 返回什么，外层调用者就拿到什么）。
 * - 持久化只保留小时聚合，键 `hourKey|provider|model|purpose`；保留最近 400 天。
 * - 进程内另存最近 200 条原始调用（`recent`），不落盘。
 * - 落盘原子写（`.tmp` + rename），每 30s 或每 50 次记录触发；`dispose()` 强制 flush。
 * - 构造期零 IO、零定时器；`start()` 才读缓存 / 挂监听 / 起定时器。
 * - 全部失败路径只写 `diag`，**绝不抛**（路由层永远能拿到一个合法视图）。
 *
 * 依赖约束：只 import `node:*` 与相对路径（不能 import 任何 @deepseek-ai/* 包）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { BUILTIN_PRICING, HOUR_MS, PRICING_BASE_CURRENCY, cacheHitRateOf, costOf, holidaySetOf, priceFor } from './fold.js'

/** 缓存文件格式版本（升级时旧文件被忽略而不是误读）。 */
const CACHE_VERSION = 1
/** 默认落盘间隔（契约 §7.1：每 30s 或每 50 次记录）。 */
const DEFAULT_FLUSH_INTERVAL_MS = 30_000
/** 默认累计记录数触发落盘。 */
const DEFAULT_FLUSH_EVERY = 50
/** 小时聚合保留窗口：400 天。 */
const RETENTION_MS = 400 * 24 * HOUR_MS
/** 进程内原始调用保留条数（契约 §7.1：最近 200 条）。 */
const RECENT_LIMIT = 200
/** `purpose` 归一化后的固定集合（契约 §7.3）。 */
const KNOWN_PURPOSES = new Set(['chat', 'compaction', 'session-title'])

/** overview/ledger 共用的时间范围定义（`null` 表示从 installedAt 起全量）。 */
const RANGE_DEFS = {
  // 今日（本地自然日 00:00 起）：与「滚动近 24h」区分，凌晨查看不会混入昨天的花费。
  today: { ms: null, label: '今日（本地 00:00 起）' },
  '24h': { ms: 24 * HOUR_MS, label: '近 24 小时' },
  '7d': { ms: 7 * 24 * HOUR_MS, label: '近 7 天' },
  '14d': { ms: 14 * 24 * HOUR_MS, label: '近 14 天' },
  '30d': { ms: 30 * 24 * HOUR_MS, label: '近 30 天' },
  all: { ms: null, label: '全部（自安装起）' },
}

/** DSH 主目录（与 collect.js 的规则保持一致）。 */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv || join(homedir(), '.dsh')
}

/** 默认落盘路径：$DSH_HOME/usage-monitor/llm-ledger.json（契约 §7.1）。 */
export function defaultLedgerCacheFile() {
  return join(dshHome(), 'usage-monitor', 'llm-ledger.json')
}

/** 永远返回有限数字；非数字 → 0（对外数字绝不出现 NaN）。 */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 本地时区当天 00:00 的 epoch ms（today range 的起点）。 */
function startOfLocalDay(time) {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** CNY（权威基准）→ USD 展示值：除以配置汇率（1 USD = rate CNY）。 */
function cnyToUsd(cny, rate) {
  return num(cny) / rate
}

/** 空 token 桶（字段名与契约 §7.1 / fold.js 一致）。 */
function emptyTokens() {
  return {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  }
}

/** 4 桶合计。 */
function totalOf(tokens) {
  return (
    num(tokens.uncachedInputTokens) +
    num(tokens.cacheReadTokens) +
    num(tokens.cacheWriteTokens) +
    num(tokens.outputTokens)
  )
}

/** TokenUsage（LLM 原生字段）→ 账本 4 桶（inputTokens 是未缓存输入，契约 §6.1）。 */
function normalizeUsage(usage) {
  return {
    uncachedInputTokens: num(usage && usage.inputTokens),
    cacheReadTokens: num(usage && usage.cacheReadTokens),
    cacheWriteTokens: num(usage && usage.cacheWriteTokens),
    outputTokens: num(usage && usage.outputTokens),
  }
}

/** 模型名归一：空字符串/非字符串 → 'unknown'。 */
function modelName(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'unknown'
}

/** purpose 归一：已知值保留，未传 = chat，未知值 = other（契约 §7.3）。 */
function normalizePurpose(value) {
  if (value === undefined || value === null || value === '') return 'chat'
  const purpose = String(value)
  return KNOWN_PURPOSES.has(purpose) ? purpose : 'other'
}

/** 小时聚合键：`hourKey|provider|model|purpose`（契约 §7.1）。 */
function entryKey(hourKey, provider, model, purpose) {
  return `${hourKey}|${provider}|${model}|${purpose}`
}

/** 解析聚合键；损坏的键返回 null（安全跳过）。 */
function parseEntryKey(key) {
  if (typeof key !== 'string') return null
  const first = key.indexOf('|')
  if (first <= 0) return null
  const hourKey = Number(key.slice(0, first))
  if (!Number.isFinite(hourKey)) return null
  const rest = key.slice(first + 1)
  const parts = rest.split('|')
  if (parts.length !== 3) return null
  return { hourKey, provider: parts[0], model: parts[1], purpose: parts[2] }
}

/** 原子写 JSON：先写 `<file>.tmp` 再 rename（同目录 rename 是原子的）。 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value), 'utf8')
  renameSync(tmp, file)
}

/** 读 JSON；任何失败（不存在/损坏/权限）返回 null。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 空账本视图（契约 §7.3 全字段，`diag` 说明为什么为空）。 */
function emptyView(range, installedAt, diag, currency, fxMeta) {
  const meta = fxMeta && typeof fxMeta === 'object' ? fxMeta : null
  const rate = meta && num(meta.rate) > 0 ? num(meta.rate) : 7.1
  return {
    generatedAt: Date.now(),
    available: false,
    installedAt: num(installedAt),
    range: { key: range.key, from: range.from, to: range.to, label: range.label },
    currency: currency === 'USD' ? 'USD' : 'CNY',
    fxRate: rate,
    fx: {
      baseCurrency: PRICING_BASE_CURRENCY,
      usdCnyRate: rate,
      source: meta && typeof meta.source === 'string' ? meta.source : 'config',
      sourceLabel: meta && typeof meta.sourceLabel === 'string' ? meta.sourceLabel : '配置兜底值（离线/获取失败）',
      effectiveDate: meta && typeof meta.effectiveDate === 'string' ? meta.effectiveDate : null,
      fetchedAt: meta && num(meta.fetchedAt) > 0 ? num(meta.fetchedAt) : 0,
      stale: meta ? meta.stale === true : true,
    },
    totals: {
      requests: 0,
      ...emptyTokens(),
      totalTokens: 0,
      cacheHitRate: 0,
      cost: 0,
      costCNY: 0,
      costUSD: 0,
    },
    byPurpose: [],
    byModel: [],
    byHour: [],
    recent: [],
    missing: 0,
    diag,
  }
}

/**
 * 创建全量调用账本。
 *
 * @param {object} ctx Host context（只需 `ctx.get` / `ctx.on`，二者都按可选处理）
 * @param {object} [options]
 * @param {string} [options.cacheFile] 落盘路径，默认 `$DSH_HOME/usage-monitor/llm-ledger.json`
 * @param {object} [options.pricing] 价格表覆盖（缺省用 fold.js 的 BUILTIN_PRICING）
 * @param {number} [options.flushIntervalMs] 落盘间隔，默认 30000
 * @param {number} [options.flushEvery] 累计记录数触发落盘，默认 50
 * @returns {{ snapshot: Function, flush: Function, start: Function, dispose: Function }}
 */
export function createLlmLedger(ctx, options) {
  const settings = options && typeof options === 'object' ? options : {}
  const cacheFile =
    typeof settings.cacheFile === 'string' && settings.cacheFile.trim() !== ''
      ? settings.cacheFile
      : defaultLedgerCacheFile()
  const pricing = settings.pricing && typeof settings.pricing === 'object' ? settings.pricing : BUILTIN_PRICING
  // v5：中国法定节假日（内置 2025/2026 + 可选 options.pricingHolidays 追加）→ 节假日全天 off-peak。
  const holidays = holidaySetOf(Array.isArray(settings.pricingHolidays) ? settings.pricingHolidays : undefined)
  // 汇率只用于派生 USD 展示值（契约 §2.1 / §7.3）；CNY 金额是权威值。
  const staticUsdCnyRate =
    Number.isFinite(Number(settings.usdCnyRate)) && Number(settings.usdCnyRate) > 0 ? Number(settings.usdCnyRate) : 7.1
  // v4：实时汇率（可选）。CNY 是权威基准，实时值只用于派生 USD 展示与 fx 元数据，
  // 不参与成本计算（契约 §7.9）。
  const fxSource = settings.fxRate && typeof settings.fxRate === 'object' ? settings.fxRate : null

  /** 当前汇率元数据：实时值优先，否则配置兜底值（同步、绝不抛）。 */
  function currentFxMeta() {
    try {
      const view = fxSource && typeof fxSource.getRate === 'function' ? fxSource.getRate() : null
      if (view && typeof view === 'object' && Number.isFinite(Number(view.rate)) && Number(view.rate) > 0) {
        return {
          rate: Number(view.rate),
          source: typeof view.source === 'string' ? view.source : 'config',
          sourceLabel: typeof view.sourceLabel === 'string' ? view.sourceLabel : '配置兜底值（离线/获取失败）',
          effectiveDate: typeof view.effectiveDate === 'string' ? view.effectiveDate : null,
          fetchedAt: num(view.fetchedAt),
          stale: view.stale === true,
        }
      }
    } catch {
      // 汇率服务异常不应影响账本。
    }
    return {
      rate: staticUsdCnyRate,
      source: 'config',
      sourceLabel: '配置兜底值（离线/获取失败）',
      effectiveDate: null,
      fetchedAt: 0,
      stale: true,
    }
  }
  const flushIntervalMs =
    Number.isFinite(Number(settings.flushIntervalMs)) && Number(settings.flushIntervalMs) > 0
      ? Number(settings.flushIntervalMs)
      : DEFAULT_FLUSH_INTERVAL_MS
  const flushEvery =
    Number.isFinite(Number(settings.flushEvery)) && Number(settings.flushEvery) > 0
      ? Math.floor(Number(settings.flushEvery))
      : DEFAULT_FLUSH_EVERY

  /** Map<`hourKey|provider|model|purpose`, {requests, uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}> */
  const hours = new Map()
  /** 最近 200 条原始调用（进程内，不落盘）。 */
  const recent = []
  /** 账本时间下界（契约 §7.1：首次启动写入 Date.now()，之前的调用无法追回）。 */
  let installedAt = Date.now()
  let savedAt = 0
  let recordsSinceFlush = 0
  /** 无 usage 的调用条数（进程内统计）。 */
  let missing = 0
  let started = false
  let closed = false
  let disposer = null
  let flushTimer = null
  /** 最近一次持久化失败原因（人话，见 `diag`）。 */
  let flushDiag = ''
  /** 最近一次读取缓存失败原因。 */
  let loadDiag = ''

  /** 可选服务：llm 不存在时账本标记 unavailable，但绝不阻塞插件。 */
  function llmPresent() {
    try {
      if (!ctx || typeof ctx.get !== 'function') return false
      const llm = ctx.get('llm')
      return llm !== null && llm !== undefined
    } catch {
      return false
    }
  }

  /** 当前诊断串（连接多个失败原因，不含敏感信息）。 */
  function diagText() {
    const parts = []
    if (!llmPresent()) parts.push('当前 DSH 没有 llm 服务')
    if (loadDiag) parts.push(loadDiag)
    if (flushDiag) parts.push(flushDiag)
    return parts.join('；')
  }

  /** 累加一条小时聚合。 */
  function bump(hourKey, provider, model, purpose, tokens) {
    const key = entryKey(hourKey, provider, model, purpose)
    let entry = hours.get(key)
    if (!entry) {
      entry = {
        requests: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }
      hours.set(key, entry)
    }
    entry.requests += 1
    entry.uncachedInputTokens += num(tokens.uncachedInputTokens)
    entry.outputTokens += num(tokens.outputTokens)
    entry.cacheReadTokens += num(tokens.cacheReadTokens)
    entry.cacheWriteTokens += num(tokens.cacheWriteTokens)
  }

  /** 记一次调用（成功或失败都记；usage 缺失时计入 missing）。 */
  function record(callOptions, usage, ok) {
    if (closed) return
    try {
      const at = Date.now()
      const hourKey = Math.floor(at / HOUR_MS)
      const opts = callOptions && typeof callOptions === 'object' ? callOptions : {}
      const provider = modelName(opts.provider)
      const model = modelName(opts.model)
      const purpose = normalizePurpose(opts.purpose)
      const tokens = usage ? normalizeUsage(usage) : null
      if (tokens === null) missing += 1
      else bump(hourKey, provider, model, purpose, tokens)
      // 单次调用成本（CNY）：按该次调用发生时刻选 peak/off-peak 价（不改变其他口径）。
      const price = tokens ? priceFor(model, pricing, at, holidays) : null
      const callCostCNY = tokens && price ? costOf(tokens, price) : 0
      recent.push({
        at,
        provider,
        model,
        purpose,
        totalTokens: tokens ? totalOf(tokens) : 0,
        costCNY: callCostCNY,
        ok: ok === true,
      })
      if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT)
      recordsSinceFlush += 1
      if (recordsSinceFlush >= flushEvery) save()
    } catch {
      // 记账失败绝不影响调用方（这是旁路）。
    }
  }

  /** 读取落盘缓存；失败只记 diag。 */
  function load() {
    const data = readJson(cacheFile)
    if (data === null) return
    if (!data || typeof data !== 'object' || data.version !== CACHE_VERSION) {
      loadDiag = '账本缓存版本不匹配，已忽略旧文件'
      return
    }
    installedAt = num(data.installedAt) || installedAt
    savedAt = num(data.savedAt)
    const list = Array.isArray(data.hours) ? data.hours : []
    const nowHour = Math.floor(Date.now() / HOUR_MS)
    const minHour = nowHour - Math.floor(RETENTION_MS / HOUR_MS)
    for (const row of list) {
      if (!Array.isArray(row) || row.length !== 2) continue
      const parsed = parseEntryKey(row[0])
      const value = row[1]
      if (!parsed || !value || typeof value !== 'object') continue
      if (parsed.hourKey < minHour) continue
      hours.set(row[0], {
        requests: num(value.requests),
        uncachedInputTokens: num(value.uncachedInputTokens),
        outputTokens: num(value.outputTokens),
        cacheReadTokens: num(value.cacheReadTokens),
        cacheWriteTokens: num(value.cacheWriteTokens),
      })
    }
  }

  /** 原子落盘小时聚合；失败只记 diag（绝不抛）。 */
  function save() {
    try {
      const nowHour = Math.floor(Date.now() / HOUR_MS)
      const minHour = nowHour - Math.floor(RETENTION_MS / HOUR_MS)
      const rows = []
      for (const [key, entry] of hours) {
        const parsed = parseEntryKey(key)
        if (!parsed || parsed.hourKey < minHour) {
          hours.delete(key)
          continue
        }
        rows.push([key, entry])
      }
      writeJsonAtomic(cacheFile, {
        version: CACHE_VERSION,
        installedAt,
        savedAt: Date.now(),
        hours: rows,
      })
      savedAt = Date.now()
      recordsSinceFlush = 0
      flushDiag = ''
    } catch (error) {
      flushDiag = `账本落盘失败: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)
    }
  }

  /** 解析请求的 range（未知值回落 24h）。 */
  function resolveRange(rangeKey) {
    const key = typeof rangeKey === 'string' && Object.prototype.hasOwnProperty.call(RANGE_DEFS, rangeKey) ? rangeKey : '24h'
    const def = RANGE_DEFS[key]
    const to = Date.now()
    const from =
      key === 'today' ? startOfLocalDay(to) : def.ms === null ? num(installedAt) : Math.max(0, to - def.ms)
    return { key, from, to, label: def.label }
  }

  /** 由小时聚合构建契约 §7.3 视图（同步、绝不抛）。 */
  function buildView(rangeKey, currencyKey) {
    const range = resolveRange(rangeKey)
    // 币种语义（v3.1）：成本以 **CNY** 为权威基准；USD 只是 cny / usdCnyRate 的派生展示。
    const currency = currencyKey === 'USD' ? 'USD' : 'CNY'
    // v4：每次出视图都取一次实时汇率（1 USD = rate CNY）。
    const fxMeta = currentFxMeta()
    const usdCnyRate = fxMeta.rate
    const toUSD = (cny) => cnyToUsd(cny, usdCnyRate)
    const convert = (cny) => (currency === 'CNY' ? num(cny) : toUSD(cny))
    const available = llmPresent()
    if (!available) return emptyView(range, installedAt, diagText(), currency, fxMeta)

    const totals = {
      requests: 0,
      ...emptyTokens(),
      totalTokens: 0,
      cacheHitRate: 0,
      costCNY: 0,
    }
    const byPurpose = new Map()
    const byModel = new Map()
    const byHour = new Map()

    for (const [key, entry] of hours) {
      const parsed = parseEntryKey(key)
      if (!parsed) continue
      const hourTime = parsed.hourKey * HOUR_MS
      // 桶只按 hourKey 存：只要该小时的区间与请求范围有交集就算进来
      // （`all` 的 from=installedAt 恰好落在当前小时中间，用 bucket 起点比会误杀当前小时）。
      if (hourTime + HOUR_MS <= range.from) continue
      const tokens = {
        uncachedInputTokens: num(entry.uncachedInputTokens),
        cacheReadTokens: num(entry.cacheReadTokens),
        cacheWriteTokens: num(entry.cacheWriteTokens),
        outputTokens: num(entry.outputTokens),
      }
      const requests = num(entry.requests)
      const totalTokens = totalOf(tokens)
      // 峰谷定价（v3）：按该小时桶的 UTC 起点判定 peak / off-peak（off-peak = peak 的一半）。
      // 小时桶本身就是按事件时间归档的，所以这里用 hourTime 而不是 Date.now()。
      const price = priceFor(parsed.model, pricing, hourTime, holidays)
      const costCNY = price ? costOf(tokens, price) : 0

      totals.requests += requests
      totals.uncachedInputTokens += tokens.uncachedInputTokens
      totals.cacheReadTokens += tokens.cacheReadTokens
      totals.cacheWriteTokens += tokens.cacheWriteTokens
      totals.outputTokens += tokens.outputTokens
      totals.totalTokens += totalTokens
      totals.costCNY += costCNY

      const purposeRow = byPurpose.get(parsed.purpose) || { purpose: parsed.purpose, requests: 0, totalTokens: 0, costCNY: 0 }
      purposeRow.requests += requests
      purposeRow.totalTokens += totalTokens
      purposeRow.costCNY += costCNY
      byPurpose.set(parsed.purpose, purposeRow)

      const modelKey = `${parsed.provider}\u0000${parsed.model}`
      const modelRow = byModel.get(modelKey) || {
        provider: parsed.provider,
        model: parsed.model,
        requests: 0,
        totalTokens: 0,
        costCNY: 0,
        priced: price !== null,
      }
      modelRow.requests += requests
      modelRow.totalTokens += totalTokens
      modelRow.costCNY += costCNY
      byModel.set(modelKey, modelRow)

      const hourRow = byHour.get(parsed.hourKey) || {
        hourKey: parsed.hourKey,
        time: hourTime,
        requests: 0,
        totalTokens: 0,
        costCNY: 0,
      }
      hourRow.requests += requests
      hourRow.totalTokens += totalTokens
      hourRow.costCNY += costCNY
      byHour.set(parsed.hourKey, hourRow)
    }

    totals.cacheHitRate = cacheHitRateOf({
      uncachedInputTokens: totals.uncachedInputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
    })
    for (const row of byPurpose.values()) {
      row.costCNY = Math.max(0, row.costCNY)
    }
    // 契约 §7.3 的 byPurpose/byModel 只有这些字段；不要多吐字段。
    const purposes = [...byPurpose.values()]
      .map((row) => ({
        purpose: row.purpose,
        requests: row.requests,
        totalTokens: row.totalTokens,
        cost: convert(row.costCNY),
        costCNY: row.costCNY,
        costUSD: toUSD(row.costCNY),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
    const models = [...byModel.values()]
      .map((row) => ({
        provider: row.provider,
        model: row.model,
        requests: row.requests,
        totalTokens: row.totalTokens,
        cost: convert(row.costCNY),
        costCNY: row.costCNY,
        costUSD: toUSD(row.costCNY),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
    const hourRows = [...byHour.values()]
      .sort((a, b) => a.hourKey - b.hourKey)
      .map((row) => ({
        hourKey: row.hourKey,
        time: row.time,
        requests: row.requests,
        totalTokens: row.totalTokens,
        cost: convert(row.costCNY),
        costCNY: row.costCNY,
        costUSD: toUSD(row.costCNY),
      }))

    const recentRows = recent
      .filter((row) => row.at >= range.from)
      .slice(-RECENT_LIMIT)
      .map((row) => ({
        at: num(row.at),
        provider: row.provider,
        model: row.model,
        purpose: row.purpose,
        totalTokens: num(row.totalTokens),
        cost: convert(row.costCNY),
        costCNY: num(row.costCNY),
        costUSD: toUSD(row.costCNY),
      }))

    totals.costCNY = Number.isFinite(totals.costCNY) ? Number(totals.costCNY.toFixed(10)) : 0
    totals.cost = Number.isFinite(convert(totals.costCNY)) ? Number(convert(totals.costCNY).toFixed(10)) : 0
    totals.costUSD = Number.isFinite(toUSD(totals.costCNY)) ? Number(toUSD(totals.costCNY).toFixed(10)) : 0
    return {
      generatedAt: Date.now(),
      available: true,
      installedAt: num(installedAt),
      range,
      currency,
      fxRate: usdCnyRate,
      fx: {
        baseCurrency: PRICING_BASE_CURRENCY,
        usdCnyRate,
        source: fxMeta.source,
        sourceLabel: fxMeta.sourceLabel,
        effectiveDate: fxMeta.effectiveDate,
        fetchedAt: fxMeta.fetchedAt,
        stale: fxMeta.stale,
      },
      totals,
      byPurpose: purposes,
      byModel: models,
      byHour: hourRows,
      recent: recentRows,
      missing,
      diag: diagText(),
    }
  }

  /** 包装 `next()` 返回的 AsyncIterable：原样转发、旁路采样、finally 释放。 */
  async function* wrapStream(callOptions, inner) {
    if (!inner || typeof inner[Symbol.asyncIterator] !== 'function') {
      // 防御：万一上游返回的不是异步可迭代对象，直接当作一次无 usage 的失败处理。
      record(callOptions, null, false)
      throw new TypeError('llm/stream next() did not return an AsyncIterable')
    }
    let usage = null
    let recorded = false
    let failed = false
    let failure = null
    try {
      for await (const chunk of inner) {
        if (chunk && chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage
        yield chunk
      }
    } catch (error) {
      failed = true
      failure = error
      record(callOptions, usage, false)
      recorded = true
      throw error
    } finally {
      try {
        if (inner && typeof inner.return === 'function') await inner.return()
      } catch {
        // 释放失败不影响调用方。
      }
      if (!recorded) record(callOptions, usage, !failed && failure === null)
    }
  }

  /** `llm/stream` waterfall 监听器（注册期不抛；next() 同步抛错时原样透传）。 */
  function onStream(callOptions, next) {
    let inner
    try {
      inner = next()
    } catch (error) {
      throw error
    }
    return wrapStream(callOptions, inner)
  }

  return {
    /** 同步返回契约 §7.3 视图；任何异常降级成空视图（绝不抛）。 */
    snapshot(options) {
      const rangeKey = options && typeof options === 'object' ? options.range : undefined
      const currency = options && typeof options === 'object' ? options.currency : undefined
      try {
        return buildView(rangeKey, currency)
      } catch (error) {
        let range
        try {
          range = resolveRange(rangeKey)
        } catch {
          range = { key: '24h', from: 0, to: Date.now(), label: RANGE_DEFS['24h'].label }
        }
        return emptyView(
          range,
          installedAt,
          `账本视图构建失败: ${error instanceof Error ? error.message : String(error)}`,
          currency,
          currentFxMeta(),
        )
      }
    },

    /** 立即落盘并 resolve（失败记 diag，不 reject）。 */
    flush() {
      try {
        save()
      } catch {
        // save() 内部已兜底，这里只是双保险。
      }
      return Promise.resolve()
    },

    /** 启动：读缓存 / 挂 waterfall 监听 / 起落盘定时器（幂等、不抛）。 */
    start() {
      if (started || closed) return
      started = true
      try {
        load()
      } catch (error) {
        loadDiag = `账本缓存读取失败: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)
      }
      try {
        if (ctx && typeof ctx.on === 'function') disposer = ctx.on('llm/stream', onStream)
      } catch (error) {
        loadDiag = `llm/stream 监听注册失败: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)
      }
      try {
        flushTimer = setInterval(() => {
          try {
            save()
          } catch {
            // 定时落盘失败忽略（save 已记 diag）。
          }
        }, flushIntervalMs)
        if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref()
      } catch {
        // 定时器不可用时仍可靠 flushEvery / dispose 落盘。
      }
    },

    /** 停止并强制 flush；幂等。 */
    dispose() {
      if (closed) return
      closed = true
      if (flushTimer) {
        try {
          clearInterval(flushTimer)
        } catch {
          // 忽略
        }
        flushTimer = null
      }
      try {
        if (typeof disposer === 'function') disposer()
      } catch {
        // 忽略
      }
      disposer = null
      try {
        save()
      } catch {
        // save 内部已兜底。
      }
    },

    /** 诊断信息（测试/排障用，不属于契约）。 */
    stats() {
      return {
        started,
        closed,
        installedAt,
        savedAt,
        hours: hours.size,
        recent: recent.length,
        missing,
        recordsSinceFlush,
        cacheFile,
        diag: diagText(),
      }
    },
  }
}
