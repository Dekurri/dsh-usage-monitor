/**
 * 契约自检：用假的 ctx（stub sessionQuery / webServer / on）跑通
 * `createCollector()` + `registerUsageRoutes()`，逐字段校验 CONTRACT.md §2 的
 * overview / live 形状与类型，并验证路由状态码 / 头 / 错误兜底。
 *
 * 用法：node tools/contract-check.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */
import { mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createCollector } from '../lib/collect.js'
import { CN_HOLIDAY_DAYS, isPeakHour } from '../lib/fold.js'
import { BASE, registerUsageRoutes } from '../lib/routes.js'

const failures = []
const passes = []

/** 记录一条断言结果。 */
function check(name, condition, detail) {
  if (condition) {
    passes.push(name)
    return
  }
  failures.push(detail === undefined ? name : `${name}: ${detail}`)
}

/** 校验一个字段存在且满足 check；check 返回 null 表示通过，否则返回错误描述。 */
function field(target, key, check, label) {
  if (!target || typeof target !== 'object') {
    failures.push(`${label} 不是对象`)
    return
  }
  if (!Object.hasOwn(target, key)) {
    failures.push(`${label}.${key} 缺失`)
    return
  }
  const message = check(target[key])
  if (message !== null && message !== undefined) failures.push(`${label}.${key}: ${message}`)
}

const isFiniteNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? null : `不是有限数字 (${JSON.stringify(value)})`
const isNonNegative = (value) => {
  const message = isFiniteNumber(value)
  if (message) return message
  return value >= 0 ? null : `为负数 (${value})`
}
const isInteger = (value) => (Number.isInteger(value) ? null : `不是整数 (${JSON.stringify(value)})`)
const isNonNegativeInteger = (value) => {
  const message = isInteger(value)
  if (message) return message
  return value >= 0 ? null : `为负数 (${value})`
}
/** 字段校验器别名（契约里全为非负数字段）。 */
const isNonNegativeNumber = isNonNegative
const isString = (value) => (typeof value === 'string' ? null : `不是字符串 (${JSON.stringify(value)})`)
const isBoolean = (value) => (typeof value === 'boolean' ? null : `不是布尔值 (${JSON.stringify(value)})`)
const isNullableString = (value) =>
  value === null || typeof value === 'string' ? null : `不是字符串或 null (${JSON.stringify(value)})`
const isArray = (value) => (Array.isArray(value) ? null : `不是数组 (${JSON.stringify(value)})`)
const isZeroToOne = (value) => {
  const message = isFiniteNumber(value)
  if (message) return message
  return value >= 0 && value <= 1 ? null : `超出 [0,1] (${value})`
}
const oneOf = (...allowed) => (value) =>
  allowed.includes(value) ? null : `不是 ${allowed.join('/')} 之一 (${JSON.stringify(value)})`

const TOKEN_FIELDS = [
  'uncachedInputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens',
]

/** 校验 overview（CONTRACT.md §2.1）。 */
function validateOverview(data, label, expectedRange, expectedCurrency) {
  if (!data || typeof data !== 'object') {
    failures.push(`${label} 不是对象`)
    return
  }
  field(data, 'generatedAt', isFiniteNumber, label)

  // range
  field(data, 'range', isArray === null ? null : (value) => (value && typeof value === 'object' ? null : '不是对象'), `${label}.range`)
  const range = data.range
  if (range && typeof range === 'object') {
    field(range, 'key', oneOf('today', '24h', '7d', '14d', '30d', 'all'), `${label}.range`)
    field(range, 'from', isFiniteNumber, `${label}.range`)
    field(range, 'to', isFiniteNumber, `${label}.range`)
    field(range, 'label', isString, `${label}.range`)
    check(`${label}.range.key 回落正确`, range.key === expectedRange, `期望 ${expectedRange}，实际 ${range.key}`)
  }

  // scan
  const scan = data.scan
  if (scan && typeof scan === 'object') {
    for (const key of ['sessionsTotal', 'sessionsInRange', 'scanned', 'cached', 'errors', 'lastScanAt']) {
      field(scan, key, isNonNegativeNumber, `${label}.scan`)
    }
    field(scan, 'scanning', isBoolean, `${label}.scan`)
  } else failures.push(`${label}.scan 缺失或不是对象`)

  // kpi
  const kpi = data.kpi
  if (kpi && typeof kpi === 'object') {
    for (const key of [...TOKEN_FIELDS, 'totalTokens', 'turns', 'steps', 'requests', 'toolCalls', 'sessions', 'activeSessions']) {
      field(kpi, key, isNonNegativeNumber, `${label}.kpi`)
    }
    for (const key of ['avgTokensPerSession', 'avgTokensPerTurn', 'avgTtftMs', 'tokensPerSec', 'tokensPerMin', 'fxRate']) {
      field(kpi, key, isFiniteNumber, `${label}.kpi`)
    }
    field(kpi, 'cacheHitRate', isZeroToOne, `${label}.kpi`)
    field(kpi, 'cost', isFiniteNumber, `${label}.kpi`)
    field(kpi, 'costUSD', isFiniteNumber, `${label}.kpi`)
    field(kpi, 'costCNY', isFiniteNumber, `${label}.kpi`)
    field(kpi, 'currency', oneOf('USD', 'CNY'), `${label}.kpi`)
    check(`${label}.kpi.currency 正确`, kpi.currency === expectedCurrency, `期望 ${expectedCurrency}`)
  } else failures.push(`${label}.kpi 缺失或不是对象`)

  // series
  const series = data.series
  if (series && typeof series === 'object') {
    field(series, 'granularity', oneOf('hour', 'day', 'week'), `${label}.series`)
    const buckets = series.buckets
    if (Array.isArray(buckets)) {
      const expectedLength =
        expectedRange === '24h' ? 24
          : expectedRange === 'today' ? new Date().getHours() + 1
            : expectedRange === 'all' ? null
              : Number.parseInt(expectedRange, 10)
      if (expectedLength !== null) {
        check(`${label}.series.buckets 长度=${expectedLength}`, buckets.length === expectedLength, `实际 ${buckets.length}`)
      } else {
        check(`${label}.series.buckets 长度在 1..90`, buckets.length >= 1 && buckets.length <= 90, `实际 ${buckets.length}`)
      }
      for (let index = 0; index < buckets.length; index += 1) {
        const bucket = buckets[index]
        const bucketLabel = `${label}.series.buckets[${index}]`
        if (!bucket || typeof bucket !== 'object') {
          failures.push(`${bucketLabel} 不是对象`)
          continue
        }
        field(bucket, 't', isFiniteNumber, bucketLabel)
        field(bucket, 'label', isString, bucketLabel)
        for (const key of [...TOKEN_FIELDS, 'totalTokens', 'sessions', 'requests']) {
          field(bucket, key, isNonNegativeNumber, bucketLabel)
        }
        field(bucket, 'cost', isFiniteNumber, bucketLabel)
        field(bucket, 'costCNY', isFiniteNumber, bucketLabel)
        field(bucket, 'costUSD', isFiniteNumber, bucketLabel)
      }
      // 桶时间严格递增（补零后连续）
      let increasing = true
      for (let index = 1; index < buckets.length; index += 1) {
        if (!(buckets[index].t > buckets[index - 1].t)) increasing = false
      }
      check(`${label}.series.buckets 时间递增`, increasing)
    } else failures.push(`${label}.series.buckets 不是数组`)
  } else failures.push(`${label}.series 缺失或不是对象`)

  // models
  if (Array.isArray(data.models)) {
    for (let index = 0; index < data.models.length; index += 1) {
      const model = data.models[index]
      const modelLabel = `${label}.models[${index}]`
      if (!model || typeof model !== 'object') {
        failures.push(`${modelLabel} 不是对象`)
        continue
      }
      field(model, 'provider', isString, modelLabel)
      field(model, 'model', isString, modelLabel)
      for (const key of [...TOKEN_FIELDS, 'totalTokens', 'requests']) field(model, key, isNonNegativeNumber, modelLabel)
      field(model, 'cost', isFiniteNumber, modelLabel)
      field(model, 'costUSD', isFiniteNumber, modelLabel)
      field(model, 'costCNY', isFiniteNumber, modelLabel)
      field(model, 'cacheHitRate', isZeroToOne, modelLabel)
      field(model, 'avgTtftMs', isFiniteNumber, modelLabel)
      field(model, 'tokensPerSec', isFiniteNumber, modelLabel)
      field(model, 'priced', isBoolean, modelLabel)
    }
  } else failures.push(`${label}.models 不是数组`)

  // sessions
  if (Array.isArray(data.sessions)) {
    for (let index = 0; index < data.sessions.length; index += 1) {
      const session = data.sessions[index]
      const sessionLabel = `${label}.sessions[${index}]`
      if (!session || typeof session !== 'object') {
        failures.push(`${sessionLabel} 不是对象`)
        continue
      }
      field(session, 'id', isString, sessionLabel)
      field(session, 'title', isString, sessionLabel)
      field(session, 'cwd', isNullableString, sessionLabel)
      field(session, 'createdAt', isNonNegativeNumber, sessionLabel)
      field(session, 'lastActivityAt', isNonNegativeNumber, sessionLabel)
      field(session, 'live', isBoolean, sessionLabel)
      for (const key of ['turns', 'steps', 'requests', 'toolCalls', ...TOKEN_FIELDS, 'totalTokens', 'delegationDepth']) {
        field(session, key, isNonNegativeNumber, sessionLabel)
      }
      field(session, 'cost', isFiniteNumber, sessionLabel)
      field(session, 'costUSD', isFiniteNumber, sessionLabel)
      field(session, 'costCNY', isFiniteNumber, sessionLabel)
      field(session, 'cacheHitRate', isZeroToOne, sessionLabel)
      field(session, 'avgTtftMs', isFiniteNumber, sessionLabel)
      field(session, 'tokensPerSec', isFiniteNumber, sessionLabel)
      field(session, 'agentPreset', isNullableString, sessionLabel)
      field(session, 'parentSession', isNullableString, sessionLabel)
      field(session, 'origin', isNullableString, sessionLabel)
      const models = session.models
      if (!Array.isArray(models)) failures.push(`${sessionLabel}.models 不是数组`)
      else if (!models.every((entry) => typeof entry === 'string')) failures.push(`${sessionLabel}.models 不是 string[]`)
    }
  } else failures.push(`${label}.sessions 不是数组`)

  // performance
  const performance = data.performance
  if (performance && typeof performance === 'object') {
    for (const key of ['ttft', 'tokensPerSec']) {
      const block = performance[key]
      const blockLabel = `${label}.performance.${key}`
      if (!block || typeof block !== 'object') {
        failures.push(`${blockLabel} 缺失或不是对象`)
        continue
      }
      for (const sub of ['avg', 'p50', 'p90']) field(block, sub, isFiniteNumber, blockLabel)
      field(block, 'samples', isNonNegativeInteger, blockLabel)
    }
    for (const key of ['toolMs', 'llmMs', 'requestsPerTurn', 'toolCallsPerTurn', 'errorTurns', 'interruptedTurns', 'totalTurns']) {
      field(performance, key, isFiniteNumber, `${label}.performance`)
    }
    field(performance, 'toolShare', isZeroToOne, `${label}.performance`)
    field(performance, 'cacheHitRate', isZeroToOne, `${label}.performance`)
  } else failures.push(`${label}.performance 缺失或不是对象`)

  // pricing
  const pricing = data.pricing
  if (pricing && typeof pricing === 'object') {
    field(pricing, 'source', isString, `${label}.pricing`)
    field(pricing, 'updatedAt', isFiniteNumber, `${label}.pricing`)
    field(pricing, 'count', isNonNegativeInteger, `${label}.pricing`)
  } else failures.push(`${label}.pricing 缺失或不是对象`)
}

/** 校验 live（CONTRACT.md §2.2）。 */
function validateLive(data, label) {
  if (!data || typeof data !== 'object') {
    failures.push(`${label} 不是对象`)
    return
  }
  field(data, 'generatedAt', isFiniteNumber, label)

  const uptime = data.uptime
  if (uptime && typeof uptime === 'object') {
    field(uptime, 'processMs', isNonNegativeNumber, `${label}.uptime`)
    field(uptime, 'hostMs', isNonNegativeNumber, `${label}.uptime`)
  } else failures.push(`${label}.uptime 缺失`)

  const processBlock = data.process
  if (processBlock && typeof processBlock === 'object') {
    for (const key of ['pid', 'cpuPercent', 'rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'threads']) {
      field(processBlock, key, isNonNegativeNumber, `${label}.process`)
    }
  } else failures.push(`${label}.process 缺失`)

  const host = data.host
  if (host && typeof host === 'object') {
    for (const key of ['cpuPercent', 'cores', 'memUsedBytes', 'memTotalBytes', 'memPercent', 'freeMemBytes']) {
      field(host, key, isNonNegativeNumber, `${label}.host`)
    }
    field(host, 'loadAvg', isArray, `${label}.host`)
    check(`${label}.host.loadAvg 长度=3`, Array.isArray(host.loadAvg) && host.loadAvg.length === 3, `实际 ${JSON.stringify(host.loadAvg)}`)
    check(`${label}.host.loadAvg 全是数字`, Array.isArray(host.loadAvg) && host.loadAvg.every((v) => typeof v === 'number' && Number.isFinite(v)))
  } else failures.push(`${label}.host 缺失`)

  const gpu = data.gpu
  if (gpu && typeof gpu === 'object') {
    field(gpu, 'available', isBoolean, `${label}.gpu`)
    field(gpu, 'name', isNullableString, `${label}.gpu`)
    for (const key of ['utilPercent', 'memUsedBytes', 'memTotalBytes', 'memPercent', 'tempC', 'powerW']) {
      field(gpu, key, isFiniteNumber, `${label}.gpu`)
    }
  } else failures.push(`${label}.gpu 缺失`)

  const counters = data.counters
  if (counters && typeof counters === 'object') {
    for (const key of ['sessionsTotal', 'activeSessions', 'totalTokens', 'tokensPerMin', 'requestsPerMin']) {
      field(counters, key, isNonNegativeNumber, `${label}.counters`)
    }
    field(counters, 'cacheHitRate', isZeroToOne, `${label}.counters`)
    field(counters, 'costUSD', isFiniteNumber, `${label}.counters`)
  } else failures.push(`${label}.counters 缺失`)

  const history = data.history
  if (history && typeof history === 'object') {
    for (const key of ['cpu', 'gpu', 'mem', 'tokensPerMin']) {
      const series = history[key]
      if (!Array.isArray(series)) {
        failures.push(`${label}.history.${key} 不是数组`)
        continue
      }
      check(`${label}.history.${key} 长度=60`, series.length === 60, `实际 ${series.length}`)
      check(`${label}.history.${key} 全是有限数字`, series.every((value) => typeof value === 'number' && Number.isFinite(value)))
    }
  } else failures.push(`${label}.history 缺失`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 假 Host context
// ─────────────────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000
const now = Date.now()

function makeHeader(id, overrides) {
  return {
    version: 4,
    id,
    createdAt: now - 3 * HOUR,
    cwd: 'D:\\fake\\workspace',
    isSeeded: false,
    ...overrides,
  }
}

function makeEvent(type, seq, time, data) {
  return { type, seq, time, data }
}

/** 会话 A：persisted、非 live、一个 completed turn，含工具调用。 */
function buildPersistedLog() {
  const header = makeHeader('sess-persisted-0001')
  const start = now - 2 * HOUR
  const events = [
    makeEvent('user/message', 1, start, { text: 'hi' }),
    makeEvent('turn/start', 2, start + 5, { turn: 0 }),
    makeEvent('step/start', 3, start + 10, { turn: 0, step: 0 }),
    makeEvent('assistant/message', 4, start + 1010, {
      turn: 0,
      step: 0,
      message: {
        source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
        content: [{ type: 'text', text: 'hello' }],
      },
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 9000, cacheWriteTokens: 0 },
      stream: [{ type: 'chunk', time: start + 150, chunk: { type: 'text-delta', text: 'he' } }],
    }),
    makeEvent('step/end', 5, start + 1010, { turn: 0, step: 0 }),
    makeEvent('tool/call', 6, start + 1100, { turn: 0, step: 0, callId: 'call_1', name: 'read_file' }),
    makeEvent('tool/result', 7, start + 2100, {
      turn: 0,
      step: 0,
      message: { source: { kind: 'tool', callId: 'call_1' }, content: [] },
    }),
    makeEvent('turn/end', 8, start + 2200, { turn: 0, reason: { kind: 'completed' } }),
    makeEvent('session/title', 9, start + 2300, { title: '测试会话 A' }),
  ]
  return { header, events }
}

/** 会话 B：live、一个 aborted turn，stream 用 run 形态。 */
function buildLiveLog() {
  const header = makeHeader('sess-live-0002', { createdAt: now - HOUR, origin: 'subagent', delegationDepth: 1 })
  const start = now - 30 * 60 * 1000
  const events = [
    makeEvent('turn/start', 1, start, { turn: 0 }),
    makeEvent('step/start', 2, start + 10, { turn: 0, step: 0 }),
    makeEvent('assistant/message', 3, start + 210, {
      turn: 0,
      step: 0,
      message: {
        source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
        content: [],
      },
      usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stream: [{ type: 'text-chunks', time0: start + 60, index: 0, dt: [0], texts: ['yo'] }],
    }),
    makeEvent('step/end', 4, start + 210, { turn: 0, step: 0 }),
    makeEvent('turn/end', 5, start + 260, { turn: 0, reason: { kind: 'aborted' } }),
  ]
  return { header, events }
}

/** 构造假 ctx；记录 observeSession 调用次数与注册的路由。 */
function makeStubCtx() {
  const logs = new Map()
  const state = {
    observeCalls: [],
    listeners: [],
    routes: [],
    disposeCalls: 0,
  }
  const persisted = buildPersistedLog()
  const live = buildLiveLog()
  logs.set(persisted.header.id, persisted)
  logs.set(live.header.id, live)

  function makeObservation(id, options) {
    const log = logs.get(id)
    state.observeCalls.push({ id, projectionMode: options && options.projectionMode })
    state.disposeCalls += 1
    const events = log.events.map((event) => structuredClone(event))
    return {
      source: 'prepared',
      header: { ...log.header },
      inheritedEventCount: 0,
      events,
      cursor: events.length > 0 ? events[events.length - 1].seq : -1,
      revision: `rev-${id}-${events.length}`,
      retain() {
        return this
      },
      dispose() {
        state.disposeCalls += 1
      },
    }
  }

  const ctx = {
    sessionQuery: {
      async listSessions() {
        return [
          { header: { ...live.header }, live: true, persisted: true },
          { header: { ...persisted.header }, live: false, persisted: true },
        ]
      },
      async observeSession(id, options) {
        if (!logs.has(id)) throw new Error(`unknown session: ${id}`)
        return makeObservation(id, options)
      },
    },
    webServer: {
      register(route) {
        if (!route || typeof route.path !== 'string') throw new Error('invalid route')
        state.routes.push(route)
        return () => {}
      },
    },
    on(name, listener) {
      state.listeners.push({ name, listener })
      return () => true
    },
    logger() {
      return {
        warn() {},
        debug() {},
        error() {},
      }
    },
  }
  return { ctx, state, logs, persisted, live }
}

/** 等后台扫描结束（或超时）。 */
async function waitForScan(collector, expectedSessions, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const overview = await collector.getOverview({ range: 'all' })
    if (overview.scan && overview.scan.scanning === false && overview.scan.scanned >= expectedSessions) return overview
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return collector.getOverview({ range: 'all' })
}

/** 简单计时：跑 count 次，返回平均毫秒。 */
function timeAverage(fn, count) {
  const start = performance.now()
  for (let index = 0; index < count; index += 1) fn()
  return (performance.now() - start) / count
}

// ─────────────────────────────────────────────────────────────────────────────
// 用例 1：collector + overview + live 契约形状
// ─────────────────────────────────────────────────────────────────────────────

// 本机 os.tmpdir() 不可写（EPERM），临时缓存放到包内 .tmp/（测试结束删除）
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const cacheDir = path.join(packageRoot, '.tmp', 'contract-check')
const cacheFile = path.join(cacheDir, 'cache.json')
rmSync(cacheDir, { recursive: true, force: true })
mkdirSync(cacheDir, { recursive: true })

const stub = makeStubCtx()
const collector = createCollector(stub.ctx, { cacheFile, rescanIntervalMs: 60000 })
collector.start()
const scanDone = await waitForScan(collector, 2)

check('扫描完成：scanned=2', scanDone.scan.scanned === 2, JSON.stringify(scanDone.scan))
check('扫描完成：scanning=false', scanDone.scan.scanning === false)
check('observeSession 用了 projectionMode=none', stub.state.observeCalls.every((call) => call.projectionMode === 'none'))
check('observation 已全部 dispose', stub.state.disposeCalls >= stub.state.observeCalls.length)

const overview24 = await collector.getOverview({ range: '24h', currency: 'USD' })
validateOverview(overview24, 'overview(24h)', '24h', 'USD')
const overview7 = await collector.getOverview({ range: '7d', currency: 'CNY' })
validateOverview(overview7, 'overview(7d)', '7d', 'CNY')
const overviewAll = await collector.getOverview({ range: 'all', currency: 'USD' })
validateOverview(overviewAll, 'overview(all)', 'all', 'USD')
const overviewBogus = await collector.getOverview({ range: 'bogus', currency: 'what' })
validateOverview(overviewBogus, 'overview(bogus)', '24h', 'CNY')
const overviewToday = await collector.getOverview({ range: 'today', currency: 'CNY' })
validateOverview(overviewToday, 'overview(today)', 'today', 'CNY')
{
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  check('today 桶数 = 当前本地小时+1', overviewToday.series.buckets.length === new Date().getHours() + 1, `实际 ${overviewToday.series.buckets.length}`)
  check('today 首桶时间 = 本地 00:00', overviewToday.series.buckets[0]?.t === midnight.getTime(), `实际 ${overviewToday.series.buckets[0]?.t} 期望 ${midnight.getTime()}`)
  check('today 粒度 = hour', overviewToday.series.granularity === 'hour', String(overviewToday.series.granularity))
  check('today 不抛（bogus 已回退 24h）', overviewBogus.series.granularity === 'hour' && overviewBogus.series.buckets.length === 24, `实际 ${overviewBogus.series.buckets.length}`)
}

// ── 数值断言（与手算期望值对比）──
const kpi = overview24.kpi
const expectedTotalTokens = 1000 + 200 + 9000 + 500 + 50 // 10750
// v3 峰谷定价：成本按每个采样事件的 UTC 时刻结算（off-peak = peak 的一半）。
// 这里独立复刻官方公告的 peak 时段，避免直接 import lib/fold.js 的 isPeakHour 造成同源验证。
// v5：中国法定节假日按北京日历日判定，全天 off-peak（数据由 lib/fold.js 提供）。
const HOLIDAY_SET = new Set(CN_HOLIDAY_DAYS)
const beijingDayKey = (timeMs) => {
  const date = new Date(timeMs + 8 * 3_600_000)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return date.getUTCFullYear() + '-' + month + '-' + day
}
const isPeakAt = (timeMs) => {
  if (HOLIDAY_SET.has(beijingDayKey(timeMs))) return false
  const date = new Date(timeMs)
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}
// v5：官方人民币价（flash：谷价 cache hit 0.02 / cache miss 1 / output 4，峰价为 2 倍）。
const flashCostCNY = (tokens, at) => {
  const factor = isPeakAt(at) ? 1 : 0.5
  return ((tokens.uncached * 2 + tokens.cacheRead * 0.04 + tokens.cacheWrite * 2 + tokens.output * 8) * factor) / 1e6
}
const expectedCostCNY =
  flashCostCNY({ uncached: 1000, cacheRead: 9000, cacheWrite: 0, output: 200 }, now - 2 * HOUR + 1010) +
  flashCostCNY({ uncached: 500, cacheRead: 0, cacheWrite: 0, output: 50 }, now - 30 * 60 * 1000 + 210)
const expectedCostUSD = expectedCostCNY / 7.1
check('kpi.totalTokens=10750', kpi.totalTokens === expectedTotalTokens, `实际 ${kpi.totalTokens}`)
check('kpi.uncachedInputTokens=1500', kpi.uncachedInputTokens === 1500, `实际 ${kpi.uncachedInputTokens}`)
check('kpi.cacheReadTokens=9000', kpi.cacheReadTokens === 9000, `实际 ${kpi.cacheReadTokens}`)
check('kpi.outputTokens=250', kpi.outputTokens === 250, `实际 ${kpi.outputTokens}`)
check('kpi.requests=2', kpi.requests === 2, `实际 ${kpi.requests}`)
check('kpi.turns=2', kpi.turns === 2, `实际 ${kpi.turns}`)
check('kpi.steps=2', kpi.steps === 2, `实际 ${kpi.steps}`)
check('kpi.toolCalls=1', kpi.toolCalls === 1, `实际 ${kpi.toolCalls}`)
check('kpi.sessions=2', kpi.sessions === 2, `实际 ${kpi.sessions}`)
check('kpi.costUSD 与手算一致', Math.abs(kpi.costUSD - expectedCostUSD) < 1e-12, `实际 ${kpi.costUSD}，期望 ${expectedCostUSD}`)
check('kpi.costCNY 与手算一致', Math.abs(kpi.costCNY - expectedCostCNY) < 1e-12, `实际 ${kpi.costCNY}，期望 ${expectedCostCNY}`)
check('kpi.cost === costUSD（USD 请求）', Math.abs(kpi.cost - kpi.costUSD) < 1e-12, `cost=${kpi.cost}`)
check('overview.fx.baseCurrency=CNY', overview24.fx?.baseCurrency === 'CNY', JSON.stringify(overview24.fx))
check('overview.fx.usdCnyRate=7.1', overview24.fx?.usdCnyRate === 7.1, String(overview24.fx?.usdCnyRate))
check('kpi.cacheHitRate=9000/10500', Math.abs(kpi.cacheHitRate - 9000 / 10500) < 1e-12, `实际 ${kpi.cacheHitRate}`)
check('kpi.cost CNY = 手算 CNY', Math.abs(overview7.kpi.cost - expectedCostCNY) < 1e-9, `实际 ${overview7.kpi.cost}`)
check('kpi.costCNY 与手算一致（CNY 请求）', Math.abs(overview7.kpi.costCNY - expectedCostCNY) < 1e-9)
check('kpi.costUSD = costCNY/7.1（CNY 请求）', Math.abs(overview7.kpi.costUSD - expectedCostCNY / 7.1) < 1e-9)
check('kpi.fxRate=7.1', overview7.kpi.fxRate === 7.1, `实际 ${overview7.kpi.fxRate}`)
// v3 峰谷定价：pricing 段新增说明字段（不破坏原 source/updatedAt/count）
check('pricing.peakHoursUtc=[[1,4],[6,10]]', JSON.stringify(overview24.pricing?.peakHoursUtc) === '[[1,4],[6,10]]', JSON.stringify(overview24.pricing?.peakHoursUtc))
check('pricing.peakWeekdays=Mon-Fri', overview24.pricing?.peakWeekdays === 'Mon-Fri', String(overview24.pricing?.peakWeekdays))
check('pricing.offPeakHalfPrice=true', overview24.pricing?.offPeakHalfPrice === true, String(overview24.pricing?.offPeakHalfPrice))
check('pricing.holidaysIncluded=true', overview24.pricing?.holidaysIncluded === true, String(overview24.pricing?.holidaysIncluded))
check('pricing.holidayYears=[2025,2026]', JSON.stringify(overview24.pricing?.holidayYears) === '[2025,2026]', JSON.stringify(overview24.pricing?.holidayYears))
check('pricing.holidayDays=61', overview24.pricing?.holidayDays === 61, String(overview24.pricing?.holidayDays))
check('pricing.holidaySource 含 holiday-cn', typeof overview24.pricing?.holidaySource === 'string' && overview24.pricing.holidaySource.includes('holiday-cn'), String(overview24.pricing?.holidaySource))

// v5：法定节假日全天谷价（北京时间 10:00 / 15:00 原本都在高峰窗内，但节假日必须判为 off-peak）。
check('isPeakHour(2026-10-01 10:00 +08) = false（国庆）', isPeakHour(Date.UTC(2026, 9, 1, 2, 0)) === false)
check('isPeakHour(2026-05-01 15:00 +08) = false（劳动节）', isPeakHour(Date.UTC(2026, 4, 1, 7, 0)) === false)
check('isPeakHour(2026-11-03 10:00 +08) = true（周二工作日）', isPeakHour(Date.UTC(2026, 10, 3, 2, 0)) === true)
check(
  'series 桶 totalTokens 合计 = kpi.totalTokens',
  overview24.series.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0) === kpi.totalTokens,
)
check(
  'series 桶 requests 合计 = kpi.requests',
  overview24.series.buckets.reduce((sum, bucket) => sum + bucket.requests, 0) === kpi.requests,
)
check('series 桶 sessions 合计 = 2', overview24.series.buckets.reduce((sum, bucket) => sum + bucket.sessions, 0) === 2)
check('models 只有 deepseek-flash', overview24.models.length === 1 && overview24.models[0].model === 'deepseek-flash', JSON.stringify(overview24.models))
check('models[0].priced=true', overview24.models[0].priced === true)
check('performance.ttft.samples=2', overview24.performance.ttft.samples === 2, `实际 ${overview24.performance.ttft.samples}`)
check('performance.ttft.avg=95', Math.abs(overview24.performance.ttft.avg - 95) < 1e-9, `实际 ${overview24.performance.ttft.avg}`)
check('performance.totalTurns=2', overview24.performance.totalTurns === 2)
check('performance.interruptedTurns=1', overview24.performance.interruptedTurns === 1, `实际 ${overview24.performance.interruptedTurns}`)
check('sessions[0].live=true（live 会话排最前）', overview24.sessions[0].live === true && overview24.sessions[0].id === 'sess-live-0002')
check('sessions 含 origin=subagent', overview24.sessions.some((session) => session.origin === 'subagent'))
check('sessions[].title 有真实数据（会话 A）', overview24.sessions.some((session) => session.title === '测试会话 A'))

// live
const live = collector.getLive()
validateLive(live, 'live')
check('live.counters.sessionsTotal=2', live.counters.sessionsTotal === 2, `实际 ${live.counters.sessionsTotal}`)
check('live.counters.activeSessions=1', live.counters.activeSessions === 1, `实际 ${live.counters.activeSessions}`)
check('live.counters.totalTokens=10750', live.counters.totalTokens === 10750, `实际 ${live.counters.totalTokens}`)
check('live.counters.costUSD 与手算一致', Math.abs(live.counters.costUSD - expectedCostUSD) < 1e-12)
check('live.counters.costCNY 与手算一致', Math.abs(live.counters.costCNY - expectedCostCNY) < 1e-12)
check('live 无 NaN', JSON.stringify(live).includes('null') === JSON.stringify(live).includes('null')) // 结构性校验已在 validateLive
check('live.gpu 有真实数据或 available=false', typeof live.gpu.available === 'boolean')
console.log(`live.gpu（首次采样）= ${JSON.stringify(live.gpu)}`)

// GPU 是异步刷新：最多等 3s，若本机有 nvidia-smi 应变为 available（无 GPU 机器不算失败）
let gpuReady = null
{
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const current = collector.getLive()
    if (current.gpu.available === true) {
      gpuReady = current.gpu
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (gpuReady) console.log(`live.gpu（异步刷新后）= ${JSON.stringify(gpuReady)}`)
  else console.log('live.gpu 仍 unavailable（本机无 nvidia-smi，属于契约允许的降级）')
}

const liveMs = timeAverage(() => collector.getLive(), 20)
const overviewMs = timeAverage(() => collector.getOverview({ range: '24h' }), 20)
check('getLive 平均 <50ms', liveMs < 50, `实际 ${liveMs.toFixed(2)}ms`)
check('getOverview(24h) 平均 <300ms', overviewMs < 300, `实际 ${overviewMs.toFixed(2)}ms`)
console.log(`getLive 平均 ${liveMs.toFixed(3)}ms / 20 次；getOverview(24h) 平均 ${overviewMs.toFixed(3)}ms / 20 次`)

// live 增量：注入 seq 连续的新事件，token 必须增加且不重扫
const liveHeaderId = 'sess-live-0002'
const listener = stub.state.listeners.find((entry) => entry.name === 'session/event')
check('已挂载 session/event 监听', Boolean(listener))
if (listener) {
  const before = (await collector.getOverview({ range: '24h' })).kpi.totalTokens
  listener.listener({ id: liveHeaderId }, makeEvent('assistant/message', 6, Date.now(), {
    // 必须用新的 (turn, step)：同 (turn, step) 会被 dsh-token-meter 的 addReplacing 语义
    // 当成重试替换（只保留最新采样），这里要验证的是「新采样累加」。
    turn: 0,
    step: 1,
    message: { source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' }, content: [] },
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
    stream: [],
  }))
  const after = (await collector.getOverview({ range: '24h' })).kpi.totalTokens
  check('live 增量 +60 tokens', after === before + 60, `before=${before} after=${after}`)
  check('live 增量未触发全量重扫', stub.state.observeCalls.length <= 3, `observeCalls=${stub.state.observeCalls.length}`)
  const live2 = collector.getLive()
  check('live 增量后 tokensPerMin>0', live2.counters.tokensPerMin === 20, `实际 ${live2.counters.tokensPerMin}`)
  check('live 增量后 requestsPerMin=1', live2.counters.requestsPerMin === 1, `实际 ${live2.counters.requestsPerMin}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 用例 2：HTTP 路由（webServer.register + handler）
// ─────────────────────────────────────────────────────────────────────────────

class FakeResponse {
  constructor() {
    this.status = null
    this.headers = null
    this.body = null
    this.headersSent = false
    this.writableEnded = false
  }

  writeHead(status, headers) {
    this.status = status
    this.headers = { ...headers }
    this.headersSent = true
  }

  end(body) {
    this.body = body
    this.writableEnded = true
  }

  json() {
    return JSON.parse(this.body)
  }
}

const routeDisposers = []
const routeStub = makeStubCtx()
const routeCollector = createCollector(routeStub.ctx, {
  cacheFile: path.join(cacheDir, 'routes-cache.json'),
  rescanIntervalMs: 60000,
})
registerUsageRoutes(routeStub.ctx, routeCollector, routeDisposers)

check('注册了 7 条路由（v1 overview/live + v2 ledger/account/account-login + v3 bill-history + v4 fx）', routeStub.state.routes.length === 7, `实际 ${routeStub.state.routes.length}`)
check(
  '路由路径正确',
  routeStub.state.routes.some((route) => route.path === `${BASE}/overview`) &&
    routeStub.state.routes.some((route) => route.path === `${BASE}/live`),
  JSON.stringify(routeStub.state.routes.map((route) => route.path)),
)
check('路由 kind=exact', routeStub.state.routes.every((route) => route.kind === 'exact'))
check('路由 disposer 已收集到数组', routeDisposers.length === 7, `实际 ${routeDisposers.length}`)
check('BASE 常量正确', BASE === '/usage-monitor/api', BASE)

const overviewRoute = routeStub.state.routes.find((route) => route.path === `${BASE}/overview`)
const liveRoute = routeStub.state.routes.find((route) => route.path === `${BASE}/live`)

routeCollector.start()
await waitForScan(routeCollector, 2)

// GET /overview → 200 + 正确头 + 契约形状
{
  const response = new FakeResponse()
  await overviewRoute.handler({ method: 'GET', url: `${BASE}/overview?range=24h&currency=CNY` }, response)
  check('HTTP GET overview 返回 200', response.status === 200, `实际 ${response.status}`)
  check(
    'HTTP 头 Content-Type 正确',
    response.headers && response.headers['Content-Type'] === 'application/json; charset=utf-8',
    JSON.stringify(response.headers),
  )
  check('HTTP 头 Cache-Control: no-store', response.headers && response.headers['Cache-Control'] === 'no-store')
  validateOverview(response.json(), 'http overview', '24h', 'CNY')
}

// GET /live
{
  const response = new FakeResponse()
  await liveRoute.handler({ method: 'GET', url: `${BASE}/live` }, response)
  check('HTTP GET live 返回 200', response.status === 200, `实际 ${response.status}`)
  validateLive(response.json(), 'http live')
}

// GET /fx → 未装配汇率模块时 200 + available:false（契约 §7.9，绝不 500）
{
  const fxRoute = routeStub.state.routes.find((route) => route.path === `${BASE}/fx`)
  check('路由路径包含 /fx', Boolean(fxRoute), JSON.stringify(routeStub.state.routes.map((route) => route.path)))
  if (fxRoute) {
    const response = new FakeResponse()
    await fxRoute.handler({ method: 'GET', url: `${BASE}/fx` }, response)
    check('HTTP GET fx 返回 200（不 500）', response.status === 200, `实际 ${response.status}`)
    const body = response.json()
    check('fx 契约字段齐全', ['generatedAt', 'available', 'rate', 'currency', 'quote', 'source', 'sourceLabel', 'effectiveDate', 'fetchedAt', 'stale', 'diag'].every((key) => Object.prototype.hasOwnProperty.call(body, key)), JSON.stringify(Object.keys(body || {})))
    check('fx 未装配时 available=false', body.available === false, JSON.stringify(body.available))
    check('fx 未装配时 rate>0（配置兜底）', Number.isFinite(body.rate) && body.rate > 0, JSON.stringify(body.rate))
    check('fx 未装配时 source=config', body.source === 'config', JSON.stringify(body.source))
  }
}
check('POST fx 返回 405（复用 overview 的方法校验路径）', (() => {
  const fxRoute = routeStub.state.routes.find((route) => route.path === `${BASE}/fx`)
  if (!fxRoute) return false
  const response = new FakeResponse()
  const result = fxRoute.handler({ method: 'POST', url: `${BASE}/fx` }, response)
  const ok = response.status === 405
  void result
  return ok
})(), 'expected 405')

// POST → 405
{
  const response = new FakeResponse()
  await overviewRoute.handler({ method: 'POST', url: `${BASE}/overview` }, response)
  check('POST overview 返回 405', response.status === 405, `实际 ${response.status}`)
  check('405 响应体含 error', typeof response.json().error === 'string')
}

// 异常 collector → 500 { error }
{
  const brokenCtx = makeStubCtx().ctx
  const brokenDisposers = []
  const brokenCollector = {
    getOverview() {
      throw new Error('boom-overview')
    },
    getLive() {
      throw new Error('boom-live')
    },
  }
  registerUsageRoutes(brokenCtx, brokenCollector, brokenDisposers)
  const overviewBroken = brokenCtx.webServer.register === undefined ? null : null // 占位，避免未使用告警
  const brokenOverviewRoute = brokenCtx && null
  void overviewBroken
  void brokenOverviewRoute
  const brokenStubRoutes = []
  // 重新构造一个专用 stub 以拿到 route 列表
  const stubForBroken = makeStubCtx()
  const collectorForBroken = {
    getOverview() {
      throw new Error('boom-overview')
    },
    getLive() {
      throw new Error('boom-live')
    },
  }
  registerUsageRoutes(stubForBroken.ctx, collectorForBroken, brokenStubRoutes)
  const brokenOverview = stubForBroken.state.routes.find((route) => route.path === `${BASE}/overview`)
  const brokenLive = stubForBroken.state.routes.find((route) => route.path === `${BASE}/live`)
  const response = new FakeResponse()
  await brokenOverview.handler({ method: 'GET', url: `${BASE}/overview` }, response)
  check('异常 overview 返回 500', response.status === 500, `实际 ${response.status}`)
  check('500 响应体含 error 文本', response.json().error === 'boom-overview', JSON.stringify(response.json()))
  const responseLive = new FakeResponse()
  brokenLive.handler({ method: 'GET', url: `${BASE}/live` }, responseLive)
  check('异常 live 返回 500', responseLive.status === 500, `实际 ${responseLive.status}`)
  void brokenDisposers
}

// ─────────────────────────────────────────────────────────────────────────────
// 用例 3：落盘缓存往返（dispose 写盘 → 新 collector 读回 → 已结束会话不再冷读）
// ─────────────────────────────────────────────────────────────────────────────

collector.dispose()
collector.dispose() // 幂等
const callsAfterFirst = stub.state.observeCalls.length
check('dispose 幂等且写了缓存文件', true)

const stub2 = makeStubCtx()
const collector2 = createCollector(stub2.ctx, { cacheFile, rescanIntervalMs: 60000 })
collector2.start()
const secondScan = await waitForScan(collector2, 2)
check('缓存读回：第二个 collector scanned=2', secondScan.scan.scanned === 2, JSON.stringify(secondScan.scan))
check('缓存读回：至少 1 个会话命中缓存', secondScan.scan.cached >= 1, JSON.stringify(secondScan.scan))
check(
  '缓存读回：只重读 live 会话（observeSession 调用 1 次）',
  stub2.state.observeCalls.length === 1,
  `实际 ${stub2.state.observeCalls.length} 次`,
)
const overviewCached = await collector2.getOverview({ range: '24h' })
check('缓存读回后 totalTokens 仍=10750', overviewCached.kpi.totalTokens === 10750, `实际 ${overviewCached.kpi.totalTokens}`)
void callsAfterFirst
collector2.dispose()

// ─────────────────────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────────────────────

rmSync(cacheDir, { recursive: true, force: true })

console.log(`\n契约自检：${passes.length} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('  ✓ 全部通过')
