/**
 * dsh-usage-monitor — v4 实时汇率（央行中间价）。
 *
 * 用户要求「汇率实时符合央行发布的汇率」。本模块从**央行授权发布的中国外汇交易中心
 * （CFETS）**抓取 USD/CNY 中间价，并提供一个同步、绝不抛、绝不发请求的 `getRate()`
 * 视图，供 collect / llm-ledger / routes 使用。
 *
 * 数据源优先级（契约 §7.9，均由 Lead 实测确认可用）：
 *   1. `pboc-cfets`         CFETS 实时中间价快照（ccpr.json）
 *   2. `pboc-cfets-history` CFETS 历史中间价接口（最近交易日）
 *   3. `market`             第三方市场汇率（**非央行口径**，展示时必须标注）
 *   4. `config`             配置里的 `fx.USDCNY`（最终兜底 / 离线值）
 *
 * 成本口径（**不要改**）：CNY 是唯一权威基准。`BUILTIN_PRICING` 是按汇率 7.1 快照
 * 换算的人民币价表，实时汇率**只**用于 `costUSD = costCNY / fxRate` 的派生展示与
 * `fx` 元数据；绝不用它重算历史成本，否则历史金额会随汇率漂移。
 *
 * 生命周期：构造期零 IO、零请求；`start()` 才读缓存 + 起定时刷新（定时器必须
 * `unref()`，不拖住宿主退出）；`dispose()` 幂等。
 *
 * @module
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 缓存文件格式版本（升级时旧文件被忽略而不是误读）。 */
const CACHE_VERSION = 1
/** 默认刷新间隔：30 分钟（中间价每日约 09:15 北京时间发布，30 分钟轮询足够）。 */
const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60 * 1000
/** 配置兜底汇率（1 USD = N CNY）。 */
const DEFAULT_CONFIG_RATE = 7.1
/** 单次抓取超时。 */
const DEFAULT_TIMEOUT_MS = 8000
/** 缓存有效期：24 小时内先用缓存、再异步刷新。 */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** 主源：CFETS 人民币汇率中间价实时快照（央行授权发布）。 */
const PRIMARY_URL = 'https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/fx/ccpr.json'
/** 备源：CFETS 历史中间价（同一站点，含最近多个交易日）。 */
const HISTORY_URL_BASE = 'https://www.chinamoney.com.cn/ags/ms/cm-u-bk-ccpr/CcprHisNew'
/** 兜底源：第三方市场汇率（非央行口径；Host 内直连可能失败，失败即放弃、不重试）。 */
const MARKET_URL = 'https://api.exchangerate-api.com/v4/latest/USD'
/** 请求头：该站点若无 UA 会拒绝。 */
const REQUEST_HEADERS = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/plain,*/*' }

/** 各数据源的展示名（UI 直接显示，必须如实标注口径）。 */
const SOURCE_LABELS = Object.freeze({
  'pboc-cfets': '中国人民银行授权·CFETS 人民币汇率中间价',
  'pboc-cfets-history': '中国人民银行授权·CFETS 历史中间价',
  market: '第三方市场汇率（非央行口径）',
  config: '配置兜底值（离线/获取失败）',
})

/** 哪些 source 属于央行口径。 */
const PBOC_SOURCES = new Set(['pboc-cfets', 'pboc-cfets-history'])

/** DSH 主目录（与 collect.js / llm-ledger.js 的规则保持一致）。 */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv || join(homedir(), '.dsh')
}

/** 默认缓存路径：$DSH_HOME/usage-monitor/fx.json（契约 §7.9）。 */
export function defaultFxCacheFile() {
  return join(dshHome(), 'usage-monitor', 'fx.json')
}

/** 有限正数校验（非有限/<=0 → null）。 */
function positive(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 取字符串的日期部分（`2026-11-02 9:15` → `2026-11-02`）。 */
function datePart(value) {
  if (typeof value !== 'string') return null
  const iso = value.match(/(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  // 备用格式：`02/11/2026 9:15`（lastDateEn）
  const en = value.match(/(\d{2})\/(\d{2})\/(\d{4})/)
  if (en) return `${en[3]}-${en[2]}-${en[1]}`
  return null
}

/**
 * 解析主源（ccpr.json）：取 `vrtEName === 'USD/CNY'` 的 `price`，生效日取 `data.lastDate`。
 * 脏输入一律返回 null（不抛）。
 *
 * @param {unknown} payload JSON 对象
 * @returns {{ rate: number, effectiveDate: string|null } | null}
 */
export function parseCfetsSnapshot(payload) {
  try {
    if (!payload || typeof payload !== 'object') return null
    const records = payload.records
    if (!Array.isArray(records)) return null
    let rate = null
    for (const record of records) {
      if (!record || typeof record !== 'object') continue
      const pair = typeof record.vrtEName === 'string' ? record.vrtEName.trim().toUpperCase() : ''
      if (pair !== 'USD/CNY') continue
      rate = positive(record.price)
      if (rate !== null) break
    }
    if (rate === null) return null
    const data = payload.data && typeof payload.data === 'object' ? payload.data : {}
    return { rate, effectiveDate: datePart(data.lastDate) ?? datePart(data.lastDateEn) }
  } catch {
    return null
  }
}

/**
 * 解析备源（CcprHisNew）：`records[0].date` / `records[0].values[0]` 即最新交易日。
 * 脏输入一律返回 null（不抛）。
 *
 * @param {unknown} payload JSON 对象
 * @returns {{ rate: number, effectiveDate: string|null } | null}
 */
export function parseCfetsHistory(payload) {
  try {
    if (!payload || typeof payload !== 'object') return null
    const records = payload.records
    if (!Array.isArray(records)) return null
    for (const record of records) {
      if (!record || typeof record !== 'object') continue
      const values = record.values
      if (!Array.isArray(values)) continue
      const rate = positive(values[0])
      if (rate === null) continue
      return { rate, effectiveDate: datePart(record.date) }
    }
    return null
  } catch {
    return null
  }
}

/**
 * 解析第三方市场汇率：`rates.CNY`。非央行口径。
 * 脏输入一律返回 null（不抛）。
 *
 * @param {unknown} payload JSON 对象
 * @returns {{ rate: number, effectiveDate: null } | null}
 */
export function parseMarketSnapshot(payload) {
  try {
    if (!payload || typeof payload !== 'object') return null
    const rates = payload.rates
    if (!rates || typeof rates !== 'object') return null
    const rate = positive(rates.CNY)
    return rate === null ? null : { rate, effectiveDate: null }
  } catch {
    return null
  }
}

/** 本地时区 `YYYY-MM-DD`（备源查询区间用）。 */
function localYmd(epochMs) {
  const date = new Date(epochMs)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 抓取 JSON（带 UA / 超时；非 2xx 视为失败）。 */
async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response || !response.ok) {
    throw new Error(`HTTP ${response ? response.status : 'unknown'}`)
  }
  return response.json()
}

/** 备源 URL：查询最近 10 天区间的历史中间价。 */
function historyUrl(now) {
  const end = now
  const start = now - 10 * 24 * 60 * 60 * 1000
  const params = new URLSearchParams({
    startDate: localYmd(start),
    endDate: localYmd(end),
    currency: 'USD/CNY',
    pageNum: '1',
    pageSize: '10',
  })
  return `${HISTORY_URL_BASE}?${params.toString()}`
}

/** 错误信息转人话短串（不输出堆栈）。 */
function shortError(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

/**
 * 创建实时汇率服务。
 *
 * @param {object} ctx Host context（本模块目前不依赖任何 Host 服务，保留参数以便未来扩展）
 * @param {object} [options]
 * @param {string} [options.cacheFile] 缓存路径，默认 `$DSH_HOME/usage-monitor/fx.json`
 * @param {number} [options.refreshIntervalMs] 刷新间隔，默认 30 分钟
 * @param {number} [options.configRate] 配置兜底汇率，默认 7.1
 * @param {number} [options.timeoutMs] 单次抓取超时，默认 8000ms
 * @param {object} [options.logger] 可选 logger（`ctx.logger` 风格）
 * @returns {{ getRate: () => object, refresh: () => Promise<object>, start: () => void, dispose: () => void }}
 */
export function createFxRate(ctx, options) {
  const settings = options && typeof options === 'object' ? options : {}
  const cacheFile =
    typeof settings.cacheFile === 'string' && settings.cacheFile.trim() !== ''
      ? settings.cacheFile
      : defaultFxCacheFile()
  const refreshIntervalMs =
    Number.isFinite(Number(settings.refreshIntervalMs)) && Number(settings.refreshIntervalMs) > 0
      ? Math.max(60_000, Math.floor(Number(settings.refreshIntervalMs)))
      : DEFAULT_REFRESH_INTERVAL_MS
  const configRate = positive(settings.configRate) ?? DEFAULT_CONFIG_RATE
  const timeoutMs =
    Number.isFinite(Number(settings.timeoutMs)) && Number(settings.timeoutMs) > 0
      ? Math.floor(Number(settings.timeoutMs))
      : DEFAULT_TIMEOUT_MS
  const logger = settings.logger && typeof settings.logger === 'object' ? settings.logger : null

  /** 当前汇率视图（唯一可变状态；getRate 只读拷贝）。 */
  let view = configView('尚未获取实时中间价，先使用配置兜底值')

  /** 刷新中的 Promise（single-flight，避免定时器与手动刷新叠加）。 */
  let refreshing = null
  /** 定时器。 */
  let timer = null
  let started = false
  let disposed = false

  /** 配置兜底视图。 */
  function configView(diag) {
    return {
      rate: configRate,
      currency: 'CNY',
      quote: 'USD',
      source: 'config',
      sourceLabel: SOURCE_LABELS.config,
      effectiveDate: null,
      fetchedAt: 0,
      stale: true,
      diag,
    }
  }

  /** getRate 返回只读拷贝，调用方不能改内部状态。 */
  function getRate() {
    return { ...view }
  }

  /** 写入缓存（原子写：同目录 .tmp → rename；失败只 log，不影响主流程）。 */
  function saveCache() {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true })
      const payload = JSON.stringify({
        version: CACHE_VERSION,
        rate: view.rate,
        effectiveDate: view.effectiveDate,
        fetchedAt: view.fetchedAt,
        source: view.source,
      })
      const tmpFile = `${cacheFile}.tmp`
      writeFileSync(tmpFile, payload, 'utf8')
      renameSync(tmpFile, cacheFile)
    } catch (error) {
      warn(`汇率缓存写入失败: ${shortError(error)}`)
    }
  }

  /** 启动时读缓存（同步、try/catch）：24h 内先用缓存，过期则等 refresh。 */
  function loadCache() {
    try {
      const text = readFileSync(cacheFile, 'utf8')
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Number(parsed.version) !== CACHE_VERSION) return
      const rate = positive(parsed.rate)
      const fetchedAt = Number(parsed.fetchedAt)
      if (rate === null || !Number.isFinite(fetchedAt)) return
      const age = Date.now() - fetchedAt
      if (age < 0 || age > CACHE_MAX_AGE_MS) return
      const source = typeof parsed.source === 'string' && SOURCE_LABELS[parsed.source] ? parsed.source : 'config'
      view = {
        rate,
        currency: 'CNY',
        quote: 'USD',
        source,
        sourceLabel: SOURCE_LABELS[source],
        effectiveDate: typeof parsed.effectiveDate === 'string' ? parsed.effectiveDate : null,
        fetchedAt,
        stale: false,
        diag: `使用 ${Math.round(age / 60_000)} 分钟前的汇率缓存，正在后台刷新`,
      }
    } catch {
      // 缓存缺失/损坏/不可读都只是「没有缓存」，不是错误。
    }
  }

  /** 记录一条警告（logger 可选、失败静默）。 */
  function warn(message) {
    try {
      logger?.warn?.(message)
    } catch {
      // 日志失败不影响主流程。
    }
  }

  /** 依次尝试 主源 → 备源 → 市场源；全部失败返回 null。 */
  async function fetchLive(now) {
    const failures = []
    try {
      const parsed = parseCfetsSnapshot(await fetchJson(PRIMARY_URL, timeoutMs))
      if (parsed) {
        return {
          ...parsed,
          source: 'pboc-cfets',
          sourceLabel: SOURCE_LABELS['pboc-cfets'],
          fetchedAt: now,
          stale: false,
          diag: '',
        }
      }
      failures.push('主源返回数据无法解析')
    } catch (error) {
      failures.push(`主源失败(${shortError(error)})`)
    }
    try {
      const parsed = parseCfetsHistory(await fetchJson(historyUrl(now), timeoutMs))
      if (parsed) {
        return {
          ...parsed,
          source: 'pboc-cfets-history',
          sourceLabel: SOURCE_LABELS['pboc-cfets-history'],
          fetchedAt: now,
          stale: false,
          diag: '',
        }
      }
      failures.push('备源返回数据无法解析')
    } catch (error) {
      failures.push(`备源失败(${shortError(error)})`)
    }
    try {
      const parsed = parseMarketSnapshot(await fetchJson(MARKET_URL, timeoutMs))
      if (parsed) {
        return {
          ...parsed,
          source: 'market',
          sourceLabel: SOURCE_LABELS.market,
          fetchedAt: now,
          stale: false,
          diag: 'CFETS 中间价不可用，已退回第三方市场汇率（非央行口径）',
        }
      }
      failures.push('市场源返回数据无法解析')
    } catch (error) {
      failures.push(`市场源失败(${shortError(error)})`)
    }
    return { failures }
  }

  /** 立即拉取一次（single-flight；绝不 reject）。 */
  function refresh() {
    if (refreshing) return refreshing
    refreshing = (async () => {
      const now = Date.now()
      try {
        const result = await fetchLive(now)
        if (result && !Array.isArray(result.failures) && positive(result.rate) !== null) {
          view = {
            rate: result.rate,
            currency: 'CNY',
            quote: 'USD',
            source: result.source,
            sourceLabel: result.sourceLabel,
            effectiveDate: result.effectiveDate ?? null,
            fetchedAt: result.fetchedAt,
            stale: false,
            diag: result.diag ?? '',
          }
          saveCache()
        } else {
          // 保留旧值（可能是缓存/上一次成功值/配置兜底），标 stale + 中文原因。
          const failures = result && Array.isArray(result.failures) ? result.failures : ['未知原因']
          view = {
            ...view,
            stale: true,
            diag: `实时汇率获取失败，沿用上一次值；${failures.join('；')}`,
          }
          warn(view.diag)
        }
      } catch (error) {
        // fetchLive 内部已兜底，这里是双保险：绝不把异常抛给调用方。
        view = { ...view, stale: true, diag: `实时汇率获取异常，沿用上一次值：${shortError(error)}` }
      }
      refreshing = null
      return getRate()
    })()
    return refreshing
  }

  /** 起定时刷新（读缓存同步完成；定时器必须 unref）。 */
  function start() {
    if (started || disposed) return
    started = true
    loadCache()
    refresh().catch(() => {
      // refresh 永不 reject；这里只是双保险。
    })
    try {
      timer = setInterval(() => {
        refresh().catch(() => {
          // 同上。
        })
      }, refreshIntervalMs)
      timer?.unref?.()
    } catch (error) {
      warn(`汇率定时器启动失败: ${shortError(error)}`)
    }
  }

  /** 幂等清理：清定时器；不再接受刷新。 */
  function dispose() {
    if (disposed) return
    disposed = true
    if (timer) {
      try {
        clearInterval(timer)
      } catch {
        // ignore
      }
      timer = null
    }
  }

  return { getRate, refresh, start, dispose }
}

/** 供测试/诊断：暴露数据源列表（不参与运行时契约）。 */
export const FX_SOURCES = Object.freeze([
  { source: 'pboc-cfets', label: SOURCE_LABELS['pboc-cfets'], pboc: true },
  { source: 'pboc-cfets-history', label: SOURCE_LABELS['pboc-cfets-history'], pboc: PBOC_SOURCES.has('pboc-cfets-history') },
  { source: 'market', label: SOURCE_LABELS.market, pboc: false },
  { source: 'config', label: SOURCE_LABELS.config, pboc: false },
])
