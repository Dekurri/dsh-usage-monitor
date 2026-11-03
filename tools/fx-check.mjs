/**
 * dsh-usage-monitor — `lib/fx.js`（v4 实时央行中间价汇率）离线自检。
 *
 * 运行：node tools/fx-check.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。
 *
 * 覆盖 task-11 验收（≥8 条）：
 *   ① 主源 fixture（Lead 实测 ccpr.json）解析出 6.7146 / 2026-11-02；
 *   ② 备源（CcprHisNew）解析；
 *   ③ 主备源都失败时回落 config 且 stale；
 *   ④ start 前 getRate() 不抛、不发请求，返回配置兜底值；
 *   ⑤ 脏输入（空 records / 非数字 price / 网络异常）不抛；
 *   ⑥ dispose 幂等；
 *   ⑦ 缓存写读回环（新实例先读缓存，再用失败刷新保持旧值 + stale）；
 *   ⑧ rate 恒 > 0，且视图字段齐全（契约 §7.9）。
 *   另加：/fx 路由 200 + 契约字段、extras null → 200 available:false、GET/POST 语义、
 *        collect 的 fx 元数据块取实时值、llm-ledger 的 fxRate 派生 USD、CNY 权威复核。
 *
 * 临时文件只写包内 `.tmp/fx-check`（本机 os.tmpdir() 不可写），用完删除。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFxRate, parseCfetsHistory, parseCfetsSnapshot, parseMarketSnapshot } from '../lib/fx.js'
import { createCollector } from '../lib/collect.js'
import { createLlmLedger } from '../lib/llm-ledger.js'
import { registerUsageRoutes, BASE } from '../lib/routes.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = dirname(here)
const tmpDir = join(pkgDir, '.tmp', 'fx-check')
const fxCacheFile = join(tmpDir, 'fx.json')
const ledgerCacheFile = join(tmpDir, 'ledger.json')
const collectCacheFile = join(tmpDir, 'collector.json')

const EXPECTED_RATE = 6.7146
const EXPECTED_DATE = '2026-11-02'
/** Lead 抓的真实主源响应（仓库父目录，只读）。 */
const REAL_FIXTURE = join(pkgDir, '..', 'ccpr.json')

let passed = 0
const failures = []

/** 记录一条断言。 */
function check(name, ok, detail) {
  if (ok) {
    passed += 1
  } else {
    failures.push(detail === undefined ? name : `${name} — ${detail}`)
  }
}

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const isNonNegative = (value) => isFiniteNumber(value) && value >= 0
const isString = (value) => typeof value === 'string'
const isStringOrNull = (value) => value === null || typeof value === 'string'
const isBoolean = (value) => typeof value === 'boolean'
const oneOf = (allowed) => (value) => allowed.includes(value)

/** 逐字段断言：字段必须存在且通过校验函数。 */
function field(obj, key, validator, label) {
  const labelText = label ? `${label}.${key}` : key
  if (!obj || !Object.prototype.hasOwnProperty.call(obj, key)) {
    check(`${labelText} 存在`, false, `缺失字段 ${labelText}`)
    return
  }
  const value = obj[key]
  let ok = false
  try {
    ok = validator(value, obj) === true
  } catch {
    ok = false
  }
  check(`${labelText} 合法`, ok, `${labelText}=${JSON.stringify(value)}`)
}

/** 契约 §7.9：FxRateView / `/fx` 响应字段。 */
function validateFxView(view, label = 'fx') {
  check(`${label} 是对象`, Boolean(view) && typeof view === 'object', typeof view)
  field(view, 'generatedAt', isFiniteNumber, label)
  field(view, 'available', isBoolean, label)
  field(view, 'rate', (value) => isFiniteNumber(value) && value > 0, label)
  field(view, 'currency', oneOf(['CNY']), label)
  field(view, 'quote', oneOf(['USD']), label)
  field(view, 'source', oneOf(['pboc-cfets', 'pboc-cfets-history', 'market', 'config']), label)
  field(view, 'sourceLabel', isString, label)
  field(view, 'effectiveDate', isStringOrNull, label)
  field(view, 'fetchedAt', isNonNegative, label)
  field(view, 'stale', isBoolean, label)
  field(view, 'diag', isString, label)
}

/** 主源 fixture（结构与官方 ccpr.json 一致）。 */
function primaryPayload(rate = EXPECTED_RATE, date = '2026-11-02 9:15') {
  return {
    data: { lastDate: date },
    records: [
      { vrtEName: 'EUR/CNY', price: '7.4650' },
      { vrtEName: 'USD/CNY', price: String(rate) },
      { vrtEName: 'JPY/CNY', price: '0.0456' },
    ],
  }
}

/** 备源 fixture（CcprHisNew 结构）。 */
function historyPayload(rate = '6.7123', date = '2026-11-01') {
  return {
    records: [
      { date, values: [rate, '7.4650'] },
      { date: '2026-10-31', values: ['6.7090'] },
    ],
  }
}

/** 第三方市场汇率 fixture（非央行口径）。 */
function marketPayload(rate = 6.71) {
  return { rates: { CNY: rate, EUR: 0.92 } }
}

/** 临时替换 globalThis.fetch，结束后恢复。 */
async function withFetch(impl, fn) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

/** 让所有抓取都失败（模拟网络异常）。 */
function offlineFetch() {
  return async () => {
    throw new Error('offline (simulated)')
  }
}

/** 极简 res 替身：捕获 status + JSON body。 */
function fakeResponse() {
  const captured = { status: 0, body: null, headers: null }
  const res = {
    writableEnded: false,
    headersSent: false,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers || null
      res.headersSent = true
      return res
    },
    end(payload) {
      res.writableEnded = true
      if (typeof payload === 'string') {
        try {
          captured.body = JSON.parse(payload)
        } catch {
          captured.body = payload
        }
      } else {
        captured.body = payload ?? null
      }
    },
  }
  return { res, captured }
}

/** 极简 webServer：收集路由表。 */
function fakeWebServer() {
  const routes = new Map()
  const disposers = []
  return {
    routes,
    disposers,
    register(route) {
      check('route.kind 是 exact', route.kind === 'exact', String(route.kind))
      check('route.path 以 / 开头且无尾斜杠', route.path.startsWith('/') && !route.path.endsWith('/'), route.path)
      routes.set(route.path, route.handler)
      const off = () => {
        routes.delete(route.path)
      }
      disposers.push(off)
      return off
    },
  }
}

/** 调一个路由，返回 captured。 */
function callRoute(routes, method, path, query) {
  const handler = routes.get(`${BASE}${path}`)
  if (typeof handler !== 'function') {
    check(`路由 ${path} 已注册`, false)
    return { status: 0, body: null }
  }
  const { res, captured } = fakeResponse()
  const req = {
    method,
    url: `/usage-monitor/api${path}${query ? `?${query}` : ''}`,
    headers: { host: '127.0.0.1:11331' },
  }
  try {
    const maybe = handler(req, res)
    if (maybe && typeof maybe.then === 'function') {
      return maybe.then(() => captured)
    }
  } catch (error) {
    captured.body = { thrown: String(error && error.message ? error.message : error) }
  }
  return captured
}

/** 轮询等待扫描结束（最多 timeoutMs）。 */
async function waitForScan(collector, timeoutMs = 4000) {
  const startedAt = Date.now()
  for (;;) {
    let scanning = false
    try {
      const overview = await collector.getOverview({ range: '24h' })
      scanning = Boolean(overview && overview.scan && overview.scan.scanning)
    } catch {
      scanning = false
    }
    if (!scanning) return true
    if (Date.now() - startedAt > timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** 主流程。 */
async function main() {
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })

  // ── 1. 解析器（主源 / 备源 / 市场源 / 脏输入） ──────────────────────────
  const primary = parseCfetsSnapshot(primaryPayload())
  check('主源解析出 rate', primary !== null && primary.rate === EXPECTED_RATE, JSON.stringify(primary))
  check('主源解析出生效日', primary !== null && primary.effectiveDate === EXPECTED_DATE, JSON.stringify(primary))

  if (existsSync(REAL_FIXTURE)) {
    const realPayload = JSON.parse(readFileSync(REAL_FIXTURE, 'utf8'))
    const realParsed = parseCfetsSnapshot(realPayload)
    check(
      '真实 ccpr.json fixture 解析出 6.7146 / 2026-11-02',
      realParsed !== null && realParsed.rate === EXPECTED_RATE && realParsed.effectiveDate === EXPECTED_DATE,
      JSON.stringify(realParsed),
    )
  } else {
    check('真实 ccpr.json fixture 存在（Lead 提供）', false, REAL_FIXTURE)
  }

  const parsedHistory = parseCfetsHistory(historyPayload())
  check(
    '备源解析出 rate 与日期',
    parsedHistory !== null && parsedHistory.rate === 6.7123 && parsedHistory.effectiveDate === '2026-11-01',
    JSON.stringify(parsedHistory),
  )

  const parsedMarket = parseMarketSnapshot(marketPayload())
  check('市场源解析出 rates.CNY', parsedMarket !== null && parsedMarket.rate === 6.71, JSON.stringify(parsedMarket))

  const dirtyInputs = [
    undefined,
    null,
    {},
    { records: 'nope' },
    { records: [] },
    { records: [{}] },
    { records: [{ vrtEName: 'USD/CNY', price: 'not-a-number' }] },
    { data: { lastDate: '2026-11-02' }, records: [{ vrtEName: 'USD/CNY', price: '-1' }] },
  ]
  let dirtyOk = true
  for (const payload of dirtyInputs) {
    try {
      if (parseCfetsSnapshot(payload) !== null) dirtyOk = false
      if (parseCfetsHistory(payload) !== null) dirtyOk = false
      if (parseMarketSnapshot(payload) !== null) dirtyOk = false
    } catch {
      dirtyOk = false
    }
  }
  check('脏输入不抛且一律返回 null', dirtyOk)

  // ── 2. start 前：同步、零 IO、配置兜底 ─────────────────────────────────
  const preStart = createFxRate({}, { cacheFile: fxCacheFile, configRate: 7.1 })
  let preView = null
  try {
    preView = preStart.getRate()
  } catch (error) {
    check('start 前 getRate 不抛', false, String(error))
  }
  check('start 前 getRate 返回配置兜底值', preView !== null && preView.rate === 7.1 && preView.source === 'config', JSON.stringify(preView))
  check('start 前 getRate 标记 stale', preView !== null && preView.stale === true, JSON.stringify(preView))
  check('start 前不创建缓存文件（构造期零 IO）', !existsSync(fxCacheFile), fxCacheFile)
  preStart.dispose()

  // ── 3. 全部数据源失败 → 配置兜底 + stale ───────────────────────────────
  const offlineFx = createFxRate({}, { cacheFile: fxCacheFile, configRate: 7.1, refreshIntervalMs: 60_000 })
  await withFetch(offlineFetch(), async () => {
    const view = await offlineFx.refresh()
    check('全源失败时 rate 回落配置值', view.rate === 7.1, JSON.stringify(view))
    check('全源失败时 source=config', view.source === 'config', JSON.stringify(view))
    check('全源失败时 stale=true', view.stale === true, JSON.stringify(view))
    check('全源失败时 diag 有中文说明', typeof view.diag === 'string' && view.diag.includes('汇率'), String(view.diag))
  })
  offlineFx.dispose()

  // ── 4. 主源成功 → pboc-cfets（含 UA 请求头与非 2xx 处理） ───────────────
  const primaryFx = createFxRate({}, { cacheFile: fxCacheFile, configRate: 7.1 })
  let sawPrimaryRequest = null
  await withFetch(
    async (url, init) => {
      sawPrimaryRequest = { url: String(url), headers: init && init.headers ? init.headers : null }
      return { ok: true, status: 200, json: async () => primaryPayload() }
    },
    async () => {
      const view = await primaryFx.refresh()
      check('主源成功时 rate=6.7146', view.rate === EXPECTED_RATE, JSON.stringify(view))
      check("主源成功时 source='pboc-cfets'", view.source === 'pboc-cfets', String(view.source))
      check(
        '主源成功时 sourceLabel 标注央行授权',
        typeof view.sourceLabel === 'string' && view.sourceLabel.includes('CFETS'),
        String(view.sourceLabel),
      )
      check('主源成功时 effectiveDate=2026-11-02', view.effectiveDate === EXPECTED_DATE, String(view.effectiveDate))
      check('主源成功时 stale=false', view.stale === false, JSON.stringify(view))
      check('fetch 请求带浏览器 UA（该站点要求）', Boolean(sawPrimaryRequest && sawPrimaryRequest.headers && /Mozilla/.test(String(sawPrimaryRequest.headers['User-Agent'] || sawPrimaryRequest.headers['user-agent'] || ''))), JSON.stringify(sawPrimaryRequest && sawPrimaryRequest.headers))
      const cachedView = primaryFx.getRate()
      check('refresh 后 getRate 与 refresh 结果一致', cachedView.rate === EXPECTED_RATE && cachedView.source === 'pboc-cfets', JSON.stringify(cachedView))
    },
  )

  // ── 5. 缓存写读回环（落盘结构 + 新实例先读缓存 + 失败刷新保持旧值） ────
  check('刷新成功后写出 fx 缓存文件', existsSync(fxCacheFile), fxCacheFile)
  const cacheRaw = JSON.parse(readFileSync(fxCacheFile, 'utf8'))
  check('缓存 version=1', cacheRaw.version === 1, JSON.stringify(cacheRaw.version))
  check('缓存 rate=6.7146', cacheRaw.rate === EXPECTED_RATE, JSON.stringify(cacheRaw.rate))
  check('缓存 effectiveDate=2026-11-02', cacheRaw.effectiveDate === EXPECTED_DATE, JSON.stringify(cacheRaw.effectiveDate))
  check('缓存 source=pboc-cfets', cacheRaw.source === 'pboc-cfets', JSON.stringify(cacheRaw.source))
  check(
    '缓存目录没有 .tmp 残留（原子写）',
    readdirSync(tmpDir).every((name) => !name.endsWith('.tmp')),
    JSON.stringify(readdirSync(tmpDir)),
  )
  check('dispose 不抛', (() => {
    try {
      primaryFx.dispose()
      return true
    } catch {
      return false
    }
  })())

  const cachedFx = createFxRate({}, { cacheFile: fxCacheFile, configRate: 7.1, refreshIntervalMs: 60_000 })
  await withFetch(offlineFetch(), async () => {
    cachedFx.start()
    const fromCache = cachedFx.getRate()
    check('新实例 start 同步读到缓存', fromCache.rate === EXPECTED_RATE, JSON.stringify(fromCache))
    check('缓存命中时先按非 stale 展示', fromCache.stale === false, JSON.stringify(fromCache))
    await cachedFx.refresh()
    const afterFailure = cachedFx.getRate()
    check('刷新失败保留旧 rate', afterFailure.rate === EXPECTED_RATE, JSON.stringify(afterFailure))
    check('刷新失败标记 stale=true', afterFailure.stale === true, JSON.stringify(afterFailure))
  })
  check('dispose 幂等（连续两次不抛）', (() => {
    try {
      cachedFx.dispose()
      cachedFx.dispose()
      return true
    } catch {
      return false
    }
  })())

  // ── 6. 备源兜底（主源失败 → CFETS 历史） ──────────────────────────────
  const historyFx = createFxRate({}, { cacheFile: join(tmpDir, 'fx-history.json'), configRate: 7.1 })
  await withFetch(
    async (url) => {
      if (String(url).includes('CcprHisNew')) {
        return { ok: true, status: 200, json: async () => historyPayload() }
      }
      return { ok: false, status: 503, json: async () => ({}) }
    },
    async () => {
      const view = await historyFx.refresh()
      check('主源失败时回落备源', view.source === 'pboc-cfets-history', String(view.source))
      check('备源 rate=6.7123', view.rate === 6.7123, JSON.stringify(view.rate))
      check('备源 effectiveDate=2026-11-01', view.effectiveDate === '2026-11-01', String(view.effectiveDate))
    },
  )
  historyFx.dispose()

  // ── 7. 市场源兜底（非央行口径） ────────────────────────────────────────
  const marketFx = createFxRate({}, { cacheFile: join(tmpDir, 'fx-market.json'), configRate: 7.1 })
  await withFetch(
    async (url) => {
      if (String(url).includes('exchangerate-api')) {
        return { ok: true, status: 200, json: async () => marketPayload() }
      }
      return { ok: false, status: 500, json: async () => ({}) }
    },
    async () => {
      const view = await marketFx.refresh()
      check("两处失败时回落市场源 source='market'", view.source === 'market', String(view.source))
      check('市场源 sourceLabel 标注非央行口径', typeof view.sourceLabel === 'string' && view.sourceLabel.includes('非央行'), String(view.sourceLabel))
    },
  )
  marketFx.dispose()

  // ── 8. 路由 /fx（契约 §7.9） ───────────────────────────────────────────
  const fakeFxView = {
    rate: EXPECTED_RATE,
    currency: 'CNY',
    quote: 'USD',
    source: 'pboc-cfets',
    sourceLabel: '中国人民银行授权·CFETS 人民币汇率中间价',
    effectiveDate: EXPECTED_DATE,
    fetchedAt: Date.now(),
    stale: false,
    diag: '',
  }
  const fakeFx = { getRate: () => ({ ...fakeFxView }) }
  const collectorStub = { getOverview: async () => ({}), getLive: () => ({}) }
  const webServer = fakeWebServer()
  registerUsageRoutes({ webServer }, collectorStub, webServer.disposers, { fxRate: fakeFx })
  check('注册了 7 条 exact 路由（含 /fx）', webServer.routes.size === 7, String(webServer.routes.size))
  const fxRouteResponse = await callRoute(webServer.routes, 'GET', '/fx')
  check('/fx GET 返回 200', fxRouteResponse.status === 200, String(fxRouteResponse.status))
  validateFxView(fxRouteResponse.body)
  check('/fx rate=6.7146', fxRouteResponse.body && fxRouteResponse.body.rate === EXPECTED_RATE, JSON.stringify(fxRouteResponse.body && fxRouteResponse.body.rate))
  check(
    '/fx 响应带 no-store 缓存头',
    Boolean(fxRouteResponse.headers) && String(fxRouteResponse.headers['Cache-Control']).includes('no-store'),
    JSON.stringify(fxRouteResponse.headers),
  )

  const nullWebServer = fakeWebServer()
  registerUsageRoutes({ webServer: nullWebServer }, collectorStub, nullWebServer.disposers, null)
  const fallbackFx = await callRoute(nullWebServer.routes, 'GET', '/fx')
  check('extras=null 时 /fx 仍 200', fallbackFx.status === 200, String(fallbackFx.status))
  check('extras=null 时 available:false', fallbackFx.body && fallbackFx.body.available === false, JSON.stringify(fallbackFx.body && fallbackFx.body.available))
  check('extras=null 时 rate 回落配置值', fallbackFx.body && fallbackFx.body.rate === 7.1, JSON.stringify(fallbackFx.body && fallbackFx.body.rate))
  check('extras=null 时 diag 有中文说明', fallbackFx.body && typeof fallbackFx.body.diag === 'string' && fallbackFx.body.diag.length > 0, String(fallbackFx.body && fallbackFx.body.diag))

  const throwingFx = { getRate: () => { throw new Error('boom-fx') } }
  const throwWebServer = fakeWebServer()
  registerUsageRoutes({ webServer: throwWebServer }, collectorStub, throwWebServer.disposers, { fxRate: throwingFx })
  const throwFx = await callRoute(throwWebServer.routes, 'GET', '/fx')
  check('getRate 抛错时 /fx 仍 200（绝不 500）', throwFx.status === 200, String(throwFx.status))
  check('getRate 抛错时 available:false 且 diag 含原因', throwFx.body && throwFx.body.available === false && String(throwFx.body.diag).includes('boom-fx'), JSON.stringify(throwFx.body && throwFx.body.diag))

  const postFx = await callRoute(webServer.routes, 'POST', '/fx')
  check('/fx POST 返回 405', postFx.status === 405, String(postFx.status))

  // ── 9. collect 的 fx 元数据块取实时值；kpi.fxRate 同源 ─────────────────
  const collectorCtx = {
    on: () => () => true,
    logger: { warn() {}, error() {} },
    sessionQuery: { listSessions: async () => [], observeSession: async () => ({}) },
  }
  const collector = createCollector(collectorCtx, { cacheFile: collectCacheFile }, { fxRate: fakeFx })
  collector.start()
  const scanSettled = await waitForScan(collector)
  check('collector 空库扫描可收敛', scanSettled === true)
  const overview = await collector.getOverview({ range: '24h', currency: 'CNY' })
  check('overview 带 fx 元数据块', Boolean(overview.fx) && typeof overview.fx === 'object', JSON.stringify(overview.fx))
  check('overview.fx.usdCnyRate=6.7146（实时值）', overview.fx && overview.fx.usdCnyRate === EXPECTED_RATE, JSON.stringify(overview.fx && overview.fx.usdCnyRate))
  check("overview.fx.source='pboc-cfets'", overview.fx && overview.fx.source === 'pboc-cfets', String(overview.fx && overview.fx.source))
  check('overview.fx.effectiveDate=2026-11-02', overview.fx && overview.fx.effectiveDate === EXPECTED_DATE, String(overview.fx && overview.fx.effectiveDate))
  check('overview.fx.baseCurrency=CNY', overview.fx && overview.fx.baseCurrency === 'CNY', String(overview.fx && overview.fx.baseCurrency))
  check('kpi.fxRate 与 fx.usdCnyRate 一致', overview.kpi && overview.kpi.fxRate === overview.fx.usdCnyRate, JSON.stringify({ kpi: overview.kpi && overview.kpi.fxRate, fx: overview.fx && overview.fx.usdCnyRate }))
  check('CNY 权威：kpi.costCNY 存在且 cost===costCNY', overview.kpi && isNonNegative(overview.kpi.costCNY) && Math.abs(overview.kpi.cost - overview.kpi.costCNY) < 1e-12, JSON.stringify({ cost: overview.kpi && overview.kpi.cost, costCNY: overview.kpi && overview.kpi.costCNY }))
  collector.dispose()

  // ── 10. llm-ledger 的 fxRate 只参与 USD 派生（CNY 权威） ───────────────
  const ledgerCtx = { get: () => ({}), on: () => () => true, logger: { warn() {} } }
  const ledger = createLlmLedger(ledgerCtx, { cacheFile: ledgerCacheFile, fxRate: fakeFx })
  const ledgerView = ledger.snapshot({ range: 'all' })
  check('ledger 视图带 fx 块', Boolean(ledgerView.fx) && typeof ledgerView.fx === 'object', JSON.stringify(ledgerView.fx))
  check('ledger.fxRate=6.7146', ledgerView.fxRate === EXPECTED_RATE, String(ledgerView.fxRate))
  check("ledger.fx.source='pboc-cfets'", ledgerView.fx && ledgerView.fx.source === 'pboc-cfets', String(ledgerView.fx && ledgerView.fx.source))
  check(
    'ledger costUSD = costCNY / rate（派生值）',
    Math.abs(ledgerView.totals.costUSD - ledgerView.totals.costCNY / EXPECTED_RATE) < 1e-9,
    JSON.stringify({ costUSD: ledgerView.totals.costUSD, costCNY: ledgerView.totals.costCNY }),
  )
  ledger.dispose()

  // ── 11. dispose 后 getRate 仍安全 ─────────────────────────────────────
  const disposable = createFxRate({}, { cacheFile: join(tmpDir, 'fx-dispose.json'), configRate: 7.1 })
  disposable.dispose()
  let afterDispose = null
  try {
    afterDispose = disposable.getRate()
  } catch (error) {
    check('dispose 后 getRate 不抛', false, String(error))
  }
  check('dispose 后 getRate 仍返回合法视图', afterDispose !== null && afterDispose.rate > 0, JSON.stringify(afterDispose))

  // ── 汇总 ──────────────────────────────────────────────────────────────
  console.log('')
  if (failures.length === 0) {
    console.log(`FX CHECK PASSED — ${passed} assertions`)
    return 0
  }
  console.log(`FX CHECK FAILED — ${passed} passed, ${failures.length} failed`)
  for (const failure of failures) {
    console.log(`  ✗ ${failure}`)
  }
  return 1
}

let exitCode = 1
try {
  exitCode = await main()
} catch (error) {
  console.error('FX CHECK CRASHED:', error)
  exitCode = 1
} finally {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore cleanup failures
  }
}
process.exit(exitCode)
