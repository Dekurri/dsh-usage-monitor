/**
 * dsh-usage-monitor — v2 调用账本自测（task-3 验收 ① / ② / ⑤ + 路由 + 持久化）。
 *
 * 运行：  node tools/ledger-check.mjs
 * 退出码：0 = 全绿；1 = 有失败（失败项会逐条打印）。
 *
 * 覆盖：
 *  1. 旁路透明性：listener 原样转发每个 chunk（引用相同、顺序不变）、立即返回可迭代对象（不缓冲）、
 *     消费结束后调用 inner.return()；
 *  2. 记账正确性：usage → 4 桶 + totalTokens + cacheHitRate + costUSD（内置峰谷价，off-peak = peak/2）；
 *     stream 内多个 usage 取最后一个；未知 purpose → 'other'；无 usage → missing+1；
 *  3. 错误语义：上游抛错原样抛给调用方（同一 Error 实例），账本记录 ok:false 且不污染 token 合计；
 *  4. 契约 §7.3 自洽：byPurpose / byModel / byHour 的 requests、totalTokens 合计都等于 totals；
 *  5. 持久化：dispose 落盘（原子写、无 .tmp 残留）→ 新实例读回后 totals 不变；
 *  6. 路由：GET /usage-monitor/api/ledger 200 + 契约字段；extras 为 null 时返回 available:false 的合法视图；
 *     非 GET → 405。
 *
 * 只写包内 .tmp/（本机 os.tmpdir() 不可用，EPERM），结束后清理。
 */

import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLlmLedger } from '../lib/llm-ledger.js'
import { CN_HOLIDAY_DAYS } from '../lib/fold.js'
import { registerUsageRoutes, BASE } from '../lib/routes.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, '..', '.tmp', 'ledger-check')
const CACHE = join(TMP, 'llm-ledger.json')

let passed = 0
const failures = []

/** 断言（收集失败，不中断）。 */
function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    return true
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  return false
}

/** 近似相等（金额浮点）。 */
function near(actual, expected, epsilon = 1e-9) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon
}

/** 假响应对象：捕获 status/headers/body。 */
function fakeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writableEnded: false,
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers || {}
    },
    end(body) {
      this.body = typeof body === 'string' ? body : String(body ?? '')
      this.writableEnded = true
      this.headersSent = true
    },
  }
}

/** 假请求对象。 */
function fakeReq(method, url, headers) {
  return { method, url, headers: headers || { host: '127.0.0.1:11331' } }
}

/** 由数组构造 AsyncIterable，可选的 throwAfter / return 追踪。 */
function makeStream(chunks, options) {
  const settings = options && typeof options === 'object' ? options : {}
  const state = { returnCalled: 0, iterated: 0 }
  const iterator = {
    async next() {
      if (settings.throwAfter !== undefined && state.iterated === settings.throwAfter) {
        throw settings.errorToThrow || new Error('sentinel upstream failure')
      }
      if (state.iterated >= chunks.length) return { done: true, value: undefined }
      const value = chunks[state.iterated]
      state.iterated += 1
      return { done: false, value }
    },
    async return() {
      state.returnCalled += 1
      return { done: true, value: undefined }
    },
  }
  // 真实 Host 里 next() 返回的是「异步生成器对象」：它本身既是可迭代对象也带 return()。
  // 这里同时提供 [Symbol.asyncIterator] 和 return，才能验证 wrapStream 的 finally 释放逻辑。
  return { state, [Symbol.asyncIterator]: () => iterator, return: (value) => iterator.return(value) }
}

/** 消费 AsyncIterable，返回收到的 chunk 数组。 */
async function consume(iterable) {
  const seen = []
  for await (const chunk of iterable) seen.push(chunk)
  return seen
}

/** 契约 §7.3 视图字段校验。 */
function validateLedgerView(view, label) {
  const prefix = `ledger:${label}`
  ok(`${prefix}: 对象`, view && typeof view === 'object')
  const heads = ['generatedAt', 'available', 'installedAt', 'range', 'totals', 'byPurpose', 'byModel', 'byHour', 'recent', 'missing', 'diag']
  for (const key of heads) ok(`${prefix}: 字段 ${key}`, Object.prototype.hasOwnProperty.call(view, key))
  ok(`${prefix}: generatedAt 数字`, Number.isFinite(view.generatedAt))
  ok(`${prefix}: available 布尔`, typeof view.available === 'boolean')
  ok(`${prefix}: installedAt 有限`, Number.isFinite(view.installedAt))
  ok(`${prefix}: range`, !!view.range && typeof view.range.key === 'string' && Number.isFinite(view.range.from) && Number.isFinite(view.range.to) && typeof view.range.label === 'string')
  const totals = view.totals || {}
  for (const key of ['requests', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens', 'cacheHitRate', 'cost', 'costCNY', 'costUSD']) {
    ok(`${prefix}: totals.${key} 有限`, Number.isFinite(totals[key]), typeof totals[key])
  }
  ok(`${prefix}: cacheHitRate 0..1`, totals.cacheHitRate >= 0 && totals.cacheHitRate <= 1)
  ok(`${prefix}: byPurpose 数组`, Array.isArray(view.byPurpose))
  ok(`${prefix}: byModel 数组`, Array.isArray(view.byModel))
  ok(`${prefix}: byHour 数组`, Array.isArray(view.byHour))
  ok(`${prefix}: recent 数组`, Array.isArray(view.recent))
  ok(`${prefix}: missing 有限`, Number.isFinite(view.missing))
  ok(`${prefix}: diag 字符串`, typeof view.diag === 'string')
}

async function main() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })

  // ---------------------------------------------------------------- 假 ctx
  let installedListener = null
  let listenerDisposed = 0
  const ctx = {
    get(name) {
      if (name === 'llm') return { name: 'fake-llm' }
      return undefined
    },
    on(name, listener) {
      if (name === 'llm/stream') installedListener = listener
      return () => {
        listenerDisposed += 1
      }
    },
  }

  const ledger = createLlmLedger(ctx, { cacheFile: CACHE, flushIntervalMs: 60_000, flushEvery: 1000 })
  ledger.start()
  ok('start: 注册 llm/stream 监听器', typeof installedListener === 'function')
  ok('start: 监听器注册在 ctx.on', installedListener !== null)

  // ------------------------------------------------------- ① 旁路透明性
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hello' },
    { type: 'usage', usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 9000, cacheWriteTokens: 0 } },
    { type: 'finish', reason: 'stop' },
  ]
  const upstream = makeStream(chunks)
  const wrapped = installedListener({ provider: 'deepseek-account', model: 'deepseek-flash', purpose: undefined, sessionId: 'session-x' }, () => upstream)
  ok('透明性: listener 同步返回 AsyncIterable', wrapped && typeof wrapped[Symbol.asyncIterator] === 'function')
  ok('透明性: 尚未消费 upstream', upstream.state.iterated === 0, `iterated=${upstream.state.iterated}`)
  const received = await consume(wrapped)
  ok('透明性: chunk 数量一致', received.length === chunks.length, `got ${received.length}`)
  ok('透明性: chunk 引用与顺序原样', received.every((chunk, index) => chunk === chunks[index]))
  ok('透明性: 消费后调用 inner.return()', upstream.state.returnCalled === 1, `returnCalled=${upstream.state.returnCalled}`)

  let view = ledger.snapshot({ range: 'all' })
  validateLedgerView(view, 'after-success')
  ok('记账: available=true', view.available === true)
  ok('记账: requests=1', view.totals.requests === 1, view.totals.requests)
  ok('记账: uncached=1000', view.totals.uncachedInputTokens === 1000, view.totals.uncachedInputTokens)
  ok('记账: cacheRead=9000', view.totals.cacheReadTokens === 9000, view.totals.cacheReadTokens)
  ok('记账: output=200', view.totals.outputTokens === 200, view.totals.outputTokens)
  ok('记账: totalTokens=10200', view.totals.totalTokens === 10200, view.totals.totalTokens)
  ok('记账: cacheHitRate=0.9', near(view.totals.cacheHitRate, 9000 / 10000, 1e-9), view.totals.cacheHitRate)
  // v5：官方人民币价表 deepseek-flash 谷价 cacheRead 0.04 / input 1 / output 4 CNY per 1M（峰价为 2 倍），
  // 周末与中国法定节假日全天按谷价。账本按小时桶起点判定峰谷，所以在当前小时桶价格下核对。
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
  const currentHour = Math.floor(Date.now() / 3_600_000) * 3_600_000
  const peakFactor = isPeakAt(currentHour) ? 1 : 0.5
  const expectedCostCNY = ((1000 * 2 + 9000 * 0.04 + 200 * 8) * peakFactor) / 1e6
  ok('记账: costCNY 与内置峰谷价一致', near(view.totals.costCNY, expectedCostCNY, 1e-12), `${view.totals.costCNY} vs ${expectedCostCNY} (peakFactor=${peakFactor})`)
  ok('记账: cost === costCNY（默认 CNY）', near(view.totals.cost, expectedCostCNY, 1e-12), String(view.totals.cost))
  // totals.costUSD 在契约里保留 10 位小数（见 llm-ledger.js buildView），容差放到 1e-10。
  ok('记账: costUSD = costCNY / 7.1', near(view.totals.costUSD, expectedCostCNY / 7.1, 1e-10), String(view.totals.costUSD))
  ok('记账: byModel 模型归属', view.byModel.length === 1 && view.byModel[0].provider === 'deepseek-account' && view.byModel[0].model === 'deepseek-flash')
  ok('记账: byPurpose 缺省 chat', view.byPurpose.length === 1 && view.byPurpose[0].purpose === 'chat')

  // 多 usage 取最后一个；purpose=compaction 单独归桶；未知 purpose → other
  const twoUsage = [
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'usage', usage: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 700 } },
  ]
  await consume(installedListener({ provider: 'deepseek-official', model: 'deepseek-v4-pro', purpose: 'compaction' }, () => makeStream(twoUsage)))
  await consume(installedListener({ provider: 'deepseek-official', model: 'deepseek-v4-pro', purpose: 'explore-something' }, () => makeStream([{ type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }])))
  {
    const today = ledger.snapshot({ range: 'today', currency: 'CNY' })
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    ok('today: range.key', today.range?.key === 'today', String(today.range?.key))
    ok('today: from = 本地 00:00', today.range?.from === midnight.getTime(), `${today.range?.from} vs ${midnight.getTime()}`)
    ok('today: currency 默认 CNY', today.currency === 'CNY', String(today.currency))
    ok('today: totals 三字段', [today.totals?.cost, today.totals?.costCNY, today.totals?.costUSD].every((v) => Number.isFinite(v)))
  }
  view = ledger.snapshot({ range: 'all' })
  ok('记账: 多 usage 取最后一个（requests=3）', view.totals.requests === 3, view.totals.requests)
  ok('记账: 多 usage 取最后一个（uncached=1310）', view.totals.uncachedInputTokens === 1310, view.totals.uncachedInputTokens)
  ok('记账: 未知 purpose → other', view.byPurpose.some((row) => row.purpose === 'other'))
  ok('记账: compaction 归桶', view.byPurpose.some((row) => row.purpose === 'compaction'))

  // ---------------------------------------------------------- ② 错误语义
  const sentinel = new Error('sentinel upstream failure')
  const failing = makeStream(
    [{ type: 'text-delta', index: 0, text: 'partial' }],
    { throwAfter: 1, errorToThrow: sentinel },
  )
  let caught = null
  try {
    await consume(installedListener({ provider: 'deepseek-account', model: 'deepseek-flash' }, () => failing))
  } catch (error) {
    caught = error
  }
  ok('错误: 原样抛出同一 Error 实例', caught === sentinel, caught && caught.message)
  view = ledger.snapshot({ range: 'all' })
  ok('错误: 不增加 token 合计', view.totals.totalTokens === 10200 + 1030 + 12, view.totals.totalTokens)
  ok('错误: 计入 missing（无 usage 的调用）', view.missing === 1, view.missing)
  ok('错误: recent 记录 ok=false', view.recent.some((row) => row.totalTokens === 0))

  // 同步 next() 抛错原样透传
  const syncError = new Error('sync next failed')
  let syncCaught = null
  try {
    installedListener({ provider: 'p', model: 'm' }, () => {
      throw syncError
    })
  } catch (error) {
    syncCaught = error
  }
  ok('错误: next() 同步抛错原样透传', syncCaught === syncError)

  // ------------------------------------------------ ⑤ 三处合计自洽
  view = ledger.snapshot({ range: 'all' })
  const sumByPurpose = view.byPurpose.reduce((sum, row) => sum + row.requests, 0)
  const sumByModel = view.byModel.reduce((sum, row) => sum + row.requests, 0)
  const sumByHour = view.byHour.reduce((sum, row) => sum + row.requests, 0)
  ok('自洽: ΣbyPurpose.requests = totals.requests', sumByPurpose === view.totals.requests, `${sumByPurpose} vs ${view.totals.requests}`)
  ok('自洽: ΣbyModel.requests = totals.requests', sumByModel === view.totals.requests, `${sumByModel} vs ${view.totals.requests}`)
  ok('自洽: ΣbyHour.requests = totals.requests', sumByHour === view.totals.requests, `${sumByHour} vs ${view.totals.requests}`)
  const sumTokensByPurpose = view.byPurpose.reduce((sum, row) => sum + row.totalTokens, 0)
  const sumTokensByModel = view.byModel.reduce((sum, row) => sum + row.totalTokens, 0)
  const sumTokensByHour = view.byHour.reduce((sum, row) => sum + row.totalTokens, 0)
  ok('自洽: ΣbyPurpose.totalTokens = totals.totalTokens', sumTokensByPurpose === view.totals.totalTokens, `${sumTokensByPurpose} vs ${view.totals.totalTokens}`)
  ok('自洽: ΣbyModel.totalTokens = totals.totalTokens', sumTokensByModel === view.totals.totalTokens)
  ok('自洽: ΣbyHour.totalTokens = totals.totalTokens', sumTokensByHour === view.totals.totalTokens)
  ok('自洽: byHour 按小时升序', view.byHour.every((row, index) => index === 0 || view.byHour[index - 1].hourKey <= row.hourKey))
  ok('自洽: recent 条数 ≤ 200 且按时间正序', view.recent.length <= 200 && view.recent.every((row, index) => index === 0 || view.recent[index - 1].at <= row.at))

  // 24h 视图包含当前小时的数据
  const view24 = ledger.snapshot({ range: '24h' })
  ok('range: 24h 包含刚记录的数据', view24.totals.requests === view.totals.requests, `${view24.totals.requests} vs ${view.totals.requests}`)
  ok('range: 未知 range 回落 24h', ledger.snapshot({ range: 'bogus' }).range.key === '24h')

  // ---------------------------------------------------- 持久化 + 原子写
  await ledger.flush()
  const leftovers = readdirSync(TMP).filter((name) => name.endsWith('.tmp'))
  ok('持久化: 落盘无 .tmp 残留', leftovers.length === 0, leftovers.join(','))
  ok('持久化: 缓存文件存在', existsSync(CACHE))
  const persisted = ledger.snapshot({ range: 'all' })
  const previousDisposed = ledger
  previousDisposed.dispose()
  previousDisposed.dispose() // 幂等
  ok('dispose: 摘除监听器', listenerDisposed === 1, listenerDisposed)

  const ledger2 = createLlmLedger(ctx, { cacheFile: CACHE, flushIntervalMs: 60_000 })
  ledger2.start()
  const reloaded = ledger2.snapshot({ range: 'all' })
  ok('持久化: 读回 totals.requests 不变', reloaded.totals.requests === persisted.totals.requests, `${reloaded.totals.requests} vs ${persisted.totals.requests}`)
  ok('持久化: 读回 totalTokens 不变', reloaded.totals.totalTokens === persisted.totals.totalTokens)
  ok('持久化: 读回 costCNY 不变', near(reloaded.totals.costCNY, persisted.totals.costCNY, 1e-12))
  ledger2.dispose()

  // ------------------------------------------------------------- 路由
  const disposers = []
  let registered = []
  const routeCtx = {
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
  }
  const collectorStub = { getOverview: async () => ({ ok: true }), getLive: () => ({ ok: true }) }
  registerUsageRoutes(routeCtx, collectorStub, disposers, { ledger, account: null })
  ok('路由: 注册 7 条 exact 路由', registered.length === 7 && registered.every((route) => route.kind === 'exact'), registered.map((r) => r.path).join(','))
  ok('路由: 路径齐全', ['overview', 'live', 'ledger', 'account', 'account/login'].every((tail) => registered.some((route) => route.path === `${BASE}/${tail}`)))
  ok('路由: disposer 收进数组', disposers.length === 7)

  const ledgerRoute = registered.find((route) => route.path === `${BASE}/ledger`)
  let res = fakeRes()
  ledgerRoute.handler(fakeReq('GET', `${BASE}/ledger?range=all`), res)
  ok('路由: GET /ledger 200', res.statusCode === 200, res.statusCode)
  ok('路由: JSON content-type', res.headers && res.headers['Content-Type'] === 'application/json; charset=utf-8', JSON.stringify(res.headers))
  ok('路由: no-store', res.headers && res.headers['Cache-Control'] === 'no-store')
  let body = null
  try {
    body = JSON.parse(res.body)
  } catch {
    body = null
  }
  validateLedgerView(body, 'http')
  ok('路由: /ledger 数据来自真实账本', body && body.available === true && body.totals.requests === persisted.totals.requests)

  res = fakeRes()
  ledgerRoute.handler(fakeReq('POST', `${BASE}/ledger`), res)
  ok('路由: 非 GET → 405', res.statusCode === 405, res.statusCode)

  // extras 为 null → 合法 fallback（绝不 500）
  const disposers2 = []
  const registered2 = []
  const routeCtx2 = { webServer: { register(route) { registered2.push(route); return () => {} } } }
  registerUsageRoutes(routeCtx2, collectorStub, disposers2, null)
  const ledgerRoute2 = registered2.find((route) => route.path === `${BASE}/ledger`)
  res = fakeRes()
  ledgerRoute2.handler(fakeReq('GET', `${BASE}/ledger?range=7d`), res)
  ok('路由: extras=null → /ledger 200', res.statusCode === 200, res.statusCode)
  let fallback = null
  try {
    fallback = JSON.parse(res.body)
  } catch {
    fallback = null
  }
  validateLedgerView(fallback, 'fallback')
  ok('路由: fallback available=false', fallback.available === false)
  ok('路由: fallback diag 非空', typeof fallback.diag === 'string' && fallback.diag.length > 0)
  ok('路由: fallback range 段有效', fallback.range.key === '7d' && fallback.range.from > 0 && fallback.range.to >= fallback.range.from)

  // ---------------------------------------------------------- 汇总
  rmSync(TMP, { recursive: true, force: true })
  if (failures.length > 0) {
    console.error(`LEDGER CHECK FAILED — ${failures.length} failed / ${passed} passed`)
    for (const failure of failures) console.error(`  ✗ ${failure}`)
    process.exitCode = 1
    return
  }
  console.log(`LEDGER CHECK PASSED — ${passed} assertions`)
  console.log(
    JSON.stringify(
      {
        requests: persisted.totals.requests,
        totalTokens: persisted.totals.totalTokens,
        uncachedInputTokens: persisted.totals.uncachedInputTokens,
        cacheReadTokens: persisted.totals.cacheReadTokens,
        outputTokens: persisted.totals.outputTokens,
        cacheHitRate: Number(persisted.totals.cacheHitRate.toFixed(6)),
        costCNY: persisted.totals.costCNY,
        missing: persisted.missing,
        byPurpose: persisted.byPurpose,
        byModel: persisted.byModel,
        byHourCount: persisted.byHour.length,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error('LEDGER CHECK CRASHED:', error && error.stack ? error.stack : error)
  process.exitCode = 1
})
