/**
 * dsh-usage-monitor — `lib/bill-history.js` 与 `/bill-history`、`/account` 账本优先逻辑的离线自检。
 *
 * 运行：node tools/bill-history-check.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。
 *
 * 覆盖 task-8 验收 ①–⑤ + 契约 §7.8 / §7.4 的补充断言：
 *   ① 真实账本文件可解析，且 ≥ 10 天；
 *   ② 单位校准：2026-10-25 的 cost === 17.407649（1 CNY = 1e8 units）；
 *   ③ 10-24 `complete === false`（只覆盖半天，必须是下界）；
 *   ④ 文件缺失时 available:false 且绝不抛；
 *   ⑤ 源文件 mtime/size 不变时第二次 load 不重读源文件（sourceReads 不增）。
 *   另加：range 过滤 / totals 自洽、落盘缓存重启复用、快照与路由契约字段校验、
 *        extras 为 null 的合法 fallback、账本可用时 /account 的 spend.today 优先取账本
 *        （≈¥10.89 而不再是自采样 ¥2.75）、账本过期时退回 balance-sampling。
 *
 * 临时文件只写包内 `.tmp/bill-history-check`（本机 os.tmpdir() 不可写），用完删除。
 */

import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createBillHistory, defaultBillHistoryFile } from '../lib/bill-history.js'
import { createAccountProbe } from '../lib/account.js'
import { registerUsageRoutes, BASE } from '../lib/routes.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = dirname(here)
const tmpDir = join(pkgDir, '.tmp', 'bill-history-check')

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

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const isNonNegative = (value) => isFiniteNumber(value) && value >= 0
const isInteger = (value) => Number.isInteger(value)
const isString = (value) => typeof value === 'string'
const isBoolean = (value) => typeof value === 'boolean'
const isStringOrNull = (value) => value === null || typeof value === 'string'
const oneOf = (allowed) => (value) => allowed.includes(value)

/** 契约 §7.8：/bill-history 的单日行。 */
function validateDay(row, label) {
  field(row, 'day', (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), label)
  field(row, 'cost', isNonNegative, label)
  field(row, 'debit', isNonNegative, label)
  field(row, 'credit', isNonNegative, label)
  field(row, 'opening', isFiniteNumber, label)
  field(row, 'closing', isFiniteNumber, label)
  field(row, 'firstAt', isFiniteNumber, label)
  field(row, 'lastAt', isFiniteNumber, label)
  field(row, 'complete', isBoolean, label)
  field(row, 'origin', oneOf(['monitor', 'whale', 'monitor+whale']), label)
}

/** 契约 §7.8：/bill-history 响应（v6：native 主源 + whale 回填）。 */
function validateBillHistory(view, label = 'billHistory') {
  check(`${label} 是对象`, Boolean(view) && typeof view === 'object', typeof view)
  field(view, 'generatedAt', isFiniteNumber, label)
  field(view, 'available', isBoolean, label)
  field(view, 'source', oneOf(['monitor', 'whale', 'monitor+whale']), label)
  field(view, 'legacySource', (value) => value === 'wallet-ledger', label)
  field(view, 'currency', oneOf(['CNY', 'USD']), label)
  field(view, 'range', (value) => Boolean(value) && typeof value === 'object', label)
  if (view && view.range && typeof view.range === 'object') {
    field(view.range, 'key', oneOf(['7d', '14d', '30d', 'all']), `${label}.range`)
    field(view.range, 'label', isString, `${label}.range`)
  }
  field(view, 'days', (value) => Array.isArray(value), label)
  if (view && Array.isArray(view.days)) {
    for (let index = 0; index < view.days.length; index += 1) {
      validateDay(view.days[index], `${label}.days[${index}]`)
    }
    const sorted = view.days.every((row, index) => index === 0 || view.days[index - 1].day <= row.day)
    check(`${label}.days 升序`, sorted)
  }
  field(view, 'since', isStringOrNull, label)
  field(view, 'until', isStringOrNull, label)
  field(
    view,
    'totals',
    (value) =>
      Boolean(value) &&
      typeof value === 'object' &&
      ['7d', '14d', '30d', 'all'].every((key) => Boolean(value[key]) && isNonNegative(value[key].cost)),
    label,
  )
  field(view, 'freshness', (value) => Boolean(value) && typeof value === 'object', label)
  if (view && view.freshness && typeof view.freshness === 'object') {
    field(view.freshness, 'fileMtime', isNonNegative, `${label}.freshness`)
    field(view.freshness, 'ageMs', isNonNegative, `${label}.freshness`)
    field(view.freshness, 'nativeDays', (value) => value === undefined || isInteger(value), `${label}.freshness`)
    field(view.freshness, 'whaleDays', (value) => value === undefined || isInteger(value), `${label}.freshness`)
  }
  field(view, 'diag', isString, label)
}

/** 契约 §7.4：/account 响应（含 v3 新增 spendSource / spendComplete）。 */
function validateAccount(view, label = 'account') {
  check(`${label} 是对象`, Boolean(view) && typeof view === 'object', typeof view)
  field(view, 'generatedAt', isFiniteNumber, label)
  field(view, 'available', isBoolean, label)
  field(view, 'signedIn', isBoolean, label)
  field(view, 'currency', oneOf(['CNY', 'USD']), label)
  field(view, 'balance', (value) => Boolean(value) && typeof value === 'object', label)
  if (view && view.balance && typeof view.balance === 'object') {
    field(view.balance, 'total', isNonNegative, `${label}.balance`)
    field(view.balance, 'recharge', isNonNegative, `${label}.balance`)
    field(view.balance, 'bonus', isNonNegative, `${label}.balance`)
  }
  field(view, 'sampledAt', isNonNegative, label)
  field(view, 'usageUrl', isString, label)
  field(view, 'topUpUrl', isString, label)
  field(view, 'spend', (value) => Boolean(value) && typeof value === 'object', label)
  if (view && view.spend && typeof view.spend === 'object') {
    for (const key of ['today', 'yesterday', 'last7d', 'last30d']) {
      field(view.spend, key, (value) => value === null || isNonNegative(value), `${label}.spend`)
    }
  }
  field(view, 'spendSource', oneOf(['wallet-ledger', 'balance-sampling']), label)
  field(view, 'spendComplete', (value) => Boolean(value) && typeof value === 'object', label)
  if (view && view.spendComplete && typeof view.spendComplete === 'object') {
    for (const key of ['today', 'yesterday', 'last7d', 'last30d']) {
      field(view.spendComplete, key, isBoolean, `${label}.spendComplete`)
    }
  }
  field(view, 'hasTopUp', isBoolean, label)
  field(view, 'diag', isString, label)
}

/** 断言 dayMap 中存在某天并返回该行。 */
function dayOf(state, key) {
  return Array.isArray(state.days) ? state.days.find((row) => row.day === key) : undefined
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

/** 极简 webServer：collect 路由表。 */
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

/** 调一个 GET 路由，返回 {status, body}。 */
function callRoute(routes, path, query) {
  const handler = routes.get(`${BASE}${path}`)
  check(`路由 ${path} 已注册`, typeof handler === 'function')
  if (typeof handler !== 'function') return { status: 0, body: null }
  const { res, captured } = fakeResponse()
  const req = { method: 'GET', url: `/usage-monitor/api${path}${query ? `?${query}` : ''}`, headers: { host: '127.0.0.1:11331' } }
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

/** 假的账号服务（浏览器登录成功态 + 一个 CNY 钱包）。 */
function fakeAccountService(walletBalance = '70.69') {
  return {
    async getState() {
      return {
        status: 'credential-stored',
        links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
        attempt: null,
      }
    },
    async getBalance() {
      return { status: 'ready', value: [{ currency: 'CNY', balance: walletBalance }], bonusWallets: [] }
    },
  }
}

/** 构造假 Host ctx。 */
function fakeCtx(webServer, accountService) {
  return {
    webServer,
    get(name) {
      if (name === 'deepseekAccount') return accountService
      if (name === 'llm') return null
      return null
    },
    logger() {
      return { error() {}, warn() {}, info() {} }
    },
    on() {
      return () => {}
    },
    effect(fn) {
      fn()
    },
  }
}

/** 假 collector（路由注册只需要它的两个方法存在）。 */
const fakeCollector = {
  getOverview: async () => ({ generatedAt: Date.now() }),
  getLive: () => ({ generatedAt: Date.now() }),
}

/**
 * 主入口：真正的 async 版本（refresh 需要 await）。
 */
async function run() {
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })

  const realFile = defaultBillHistoryFile()
  const report = { realFile }
  check('真实账本文件存在', existsSync(realFile), realFile)
  if (!existsSync(realFile)) {
    report.passed = passed
    report.failures = failures
    report.ok = false
    return report
  }

  const real = createBillHistory({ file: realFile, cacheFile: join(tmpDir, 'real-cache.json') })
  const state = real.load()
  report.state = { available: state.available, days: state.days.length, since: state.since, until: state.until, diag: state.diag }
  check('真实账本 available', state.available === true, state.diag)
  check('真实账本 ≥ 10 天', state.days.length >= 10, `days=${state.days.length}`)

  const day1025 = dayOf(state, '2026-10-25')
  check('存在 2026-10-25', Boolean(day1025))
  if (day1025) {
    check('2026-10-25 cost === 17.407649', day1025.cost === 17.407649, `cost=${day1025.cost}`)
    report.day1025 = day1025
  }
  const day1024 = dayOf(state, '2026-10-24')
  check('2026-10-24 complete === false', Boolean(day1024) && day1024.complete === false, day1024 && `complete=${day1024.complete}`)
  report.day1024 = day1024

  // ④ 缺失文件
  const missingProbe = createBillHistory({ file: join(tmpDir, 'missing.json'), cacheFile: join(tmpDir, 'missing-cache.json') })
  let missingThrew = false
  let missingState = null
  try {
    missingState = missingProbe.load()
  } catch {
    missingThrew = true
  }
  check('缺失文件 load 不抛', missingThrew === false)
  check('缺失文件 available:false', missingState && missingState.available === false)
  check('缺失文件 diag 非空', Boolean(missingState && missingState.diag))
  const missingView = missingProbe.snapshot({ range: '7d' })
  validateBillHistory(missingView, 'missing.billHistory')
  check('缺失文件 days 为空', missingView.days.length === 0)
  check('缺失文件 totals 全 0', ['7d', '14d', '30d', 'all'].every((key) => missingView.totals[key].cost === 0))
  const missingWindows = missingProbe.windows(Date.now())
  check('缺失文件 windows.available:false', missingWindows.available === false)
  check('缺失文件 windows.fresh:false', missingWindows.fresh === false)

  // ⑤ 缓存（mtime 未变不重读；落盘缓存可跨实例复用）
  const cacheProbe = createBillHistory({ file: realFile, cacheFile: join(tmpDir, 'cache-probe.json') })
  cacheProbe.load()
  const readsFirst = cacheProbe.stats().sourceReads
  cacheProbe.load()
  const readsSecond = cacheProbe.stats().sourceReads
  check('第一次 load 读源文件 1 次', readsFirst === 1, `sourceReads=${readsFirst}`)
  check('第二次 load 不重读源文件', readsSecond === readsFirst, `sourceReads=${readsSecond}`)
  check('第二次 load 命中缓存', cacheProbe.stats().cacheHits >= 1)
  const restartProbe = createBillHistory({ file: realFile, cacheFile: join(tmpDir, 'cache-probe.json') })
  const restartState = restartProbe.load()
  check('重启后复用落盘缓存（sourceReads=0）', restartProbe.stats().sourceReads === 0, `sourceReads=${restartProbe.stats().sourceReads}`)
  check('重启后天数不变', restartState.days.length === state.days.length)
  check('重启后 available', restartState.available === true, restartState.diag)

  // range / totals / 非法回落
  const allView = real.snapshot({ range: 'all' })
  validateBillHistory(allView, 'all.billHistory')
  check('all.days 等于账本全部天数', allView.days.length === state.days.length)
  const sumAll = allView.days.reduce((sum, row) => sum + row.cost, 0)
  check('all.totals.all.cost === Σdays.cost', Math.abs(allView.totals.all.cost - sumAll) < 1e-6, `${allView.totals.all.cost} vs ${sumAll}`)
  const sevenView = real.snapshot({ range: '7d' })
  validateBillHistory(sevenView, '7d.billHistory')
  check('7d.days ≤ 7', sevenView.days.length <= 7)
  const sevenSum = sevenView.days.reduce((sum, row) => sum + row.cost, 0)
  check('7d.totals.7d.cost === Σdays.cost', Math.abs(sevenView.totals['7d'].cost - sevenSum) < 1e-6)
  const bogusView = real.snapshot({ range: 'bogus' })
  check('非法 range 回落 30d', bogusView.range.key === '30d', bogusView.range.key)

  // windows()
  const now = Date.now()
  const windows = real.windows(now)
  const todayDate = new Date(now)
  const todayKey = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`
  const todayRow = dayOf(state, todayKey)
  report.windows = { available: windows.available, fresh: windows.fresh, today: windows.spend.today, last7d: windows.spend.last7d }
  check('真实账本 windows.available', windows.available === true, windows.diag)
  if (todayRow) {
    check('windows.spend.today === 账本今日 cost', Math.abs(windows.spend.today - todayRow.cost) < 1e-6, `${windows.spend.today} vs ${todayRow.cost}`)
    check('windows.complete.today 与账本一致', windows.complete.today === todayRow.complete)
  }

  // 路由
  const server = fakeWebServer()
  const routeCtx = fakeCtx(server, fakeAccountService())
  const disposers = []
  const routeBillHistory = createBillHistory({ file: realFile, cacheFile: join(tmpDir, 'route-cache.json') })
  registerUsageRoutes(routeCtx, fakeCollector, disposers, { ledger: null, account: null, billHistory: routeBillHistory })
  check('注册 7 条 exact 路由', server.routes.size === 7, `size=${server.routes.size}`)
  const billResponse = await callRouteAsync(server.routes, '/bill-history', 'range=all')
  check('GET /bill-history 200', billResponse.status === 200, `status=${billResponse.status}`)
  validateBillHistory(billResponse.body, 'route.billHistory')
  check('GET /bill-history days ≥ 10', billResponse.body.days.length >= 10)
  check('GET /bill-history available', billResponse.body.available === true)
  report.billHistoryResponse = billResponse.body

  const nullServer = fakeWebServer()
  registerUsageRoutes(fakeCtx(nullServer, null), fakeCollector, [], null)
  const nullResponse = await callRouteAsync(nullServer.routes, '/bill-history', 'range=7d')
  check('extras=null /bill-history 200', nullResponse.status === 200)
  validateBillHistory(nullResponse.body, 'fallback.billHistory')
  check('extras=null available:false', nullResponse.body.available === false)

  // /account 账本优先
  const fakeLedgerWindows = {
    available: true,
    fresh: true,
    source: 'wallet-ledger',
    ageMs: 15_000,
    spend: { today: 10.893061, yesterday: 9.5, last7d: 30.25, last30d: 60.5 },
    complete: { today: true, yesterday: true, last7d: true, last30d: false },
    coverage: {
      today: { fromAt: new Date(new Date().setHours(0, 0, 0, 0)).getTime(), complete: true },
      yesterday: { fromAt: new Date(new Date().setHours(0, 0, 0, 0)).getTime() - 86_400_000, complete: true },
      last7d: { fromAt: new Date(new Date().setHours(0, 0, 0, 0)).getTime() - 6 * 86_400_000, complete: true },
      last30d: { fromAt: null, complete: false },
    },
    credit: { today: 0, yesterday: 0, last7d: 0, last30d: 100 },
    all: { cost: 60.5, credit: 100, complete: false, covered: 10, expected: 10 },
    diag: '',
  }
  const ledgerProbe = createAccountProbe(fakeCtx(fakeWebServer(), fakeAccountService()), {
    cacheFile: join(tmpDir, 'account-ledger.json'),
    billHistory: { windows: () => fakeLedgerWindows },
  })
  await ledgerProbe.refresh()
  const ledgerView = ledgerProbe.getView()
  report.accountWithLedger = ledgerView
  validateAccount(ledgerView, 'account.ledger')
  check('账本优先 spendSource=wallet-ledger', ledgerView.spendSource === 'wallet-ledger')
  check('账本优先 spend.today ≈ 10.89', Math.abs(ledgerView.spend.today - 10.89) < 1e-6, `today=${ledgerView.spend.today}`)
  check('账本优先 spend.last7d = 30.25', ledgerView.spend.last7d === 30.25)
  check('账本优先 spendComplete.today', ledgerView.spendComplete.today === true)
  check('账本优先 hasTopUp true', ledgerView.hasTopUp === true)
  check('账本优先 signedIn/balance', ledgerView.signedIn === true && ledgerView.balance.total === 70.69)

  const staleProbe = createAccountProbe(fakeCtx(fakeWebServer(), fakeAccountService()), {
    cacheFile: join(tmpDir, 'account-stale.json'),
    billHistory: { windows: () => ({ ...fakeLedgerWindows, fresh: false, ageMs: 20 * 60_000 }) },
  })
  await staleProbe.refresh()
  const staleView = staleProbe.getView()
  report.accountStale = staleView
  validateAccount(staleView, 'account.stale')
  check('过期账本退回 balance-sampling', staleView.spendSource === 'balance-sampling')
  check('过期账本 diag 含中文原因', staleView.diag.includes('超过 10 分钟'), staleView.diag)

  const offlineProbe = createAccountProbe(fakeCtx(fakeWebServer(), null), { cacheFile: join(tmpDir, 'account-offline.json') })
  await offlineProbe.refresh()
  const offlineView = offlineProbe.getView()
  validateAccount(offlineView, 'account.offline')
  check('无账号服务 available:false', offlineView.available === false)
  check('无账号服务 spendSource=balance-sampling', offlineView.spendSource === 'balance-sampling')

  // ===== v6：native 自建按天余额账本（task-14）=====
  const realDateNow = Date.now
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const dayStart = midnight.getTime()
  const beijingKey = (at) => {
    const d = new Date(at + 8 * 3600e3)
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  const todayKeyNative = beijingKey(dayStart)

  /** 假账号服务：getBalance 按给定余额序列返回（refresh 每次消费一个）。 */
  function fakeBalanceService(balances) {
    let index = 0
    return {
      async getState() {
        return { status: 'credential-stored', links: { usageUrl: '', topUpUrl: '' }, attempt: null }
      },
      async getBalance() {
        const total = balances[Math.min(index, balances.length - 1)]
        index += 1
        return { status: 'ready', value: [{ currency: 'CNY', balance: String(total) }], bonusWallets: [] }
      },
    }
  }

  /** 在可控时钟下跑一个 native 账本场景：balances 与 offsets（相对 dayStart 的毫秒）。 */
  async function ledgerScenario(name, offsets, balances) {
    const cacheFile = join(tmpDir, `native-${name}.json`)
    const probe = createAccountProbe(fakeCtx(fakeWebServer(), fakeBalanceService(balances)), {
      cacheFile,
      refreshIntervalMs: 60_000,
    })
    let clock = dayStart
    Date.now = () => clock
    try {
      for (const offset of offsets) {
        clock = dayStart + offset
        await probe.refresh()
      }
      return probe
    } finally {
      Date.now = realDateNow
      // 调用方决定何时 dispose；这里只保证全局时钟恢复。
    }
  }

  const completeProbe = await ledgerScenario('complete', [60_000, 24 * 3600e3 - 5 * 60_000], [100, 98.5])
  const nativeDay = completeProbe.dailyLedger().days[0]
  report.nativeComplete = completeProbe.dailyLedger()
  const completeLedger = completeProbe.dailyLedger()
  check('native 账本恰好 1 天', completeLedger.days.length === 1, `days=${completeLedger.days.length}`)
  check('native 账本 day 是北京日历日', Boolean(nativeDay) && nativeDay.day === todayKeyNative, nativeDay && nativeDay.day)
  check('native 账本 cost=1.5', Boolean(nativeDay) && nativeDay.cost === 1.5, nativeDay && `cost=${nativeDay.cost}`)
  check('native 账本 debit=1.5 credit=0', Boolean(nativeDay) && nativeDay.debit === 1.5 && nativeDay.credit === 0)
  check('native 账本 opening=100 closing=98.5', Boolean(nativeDay) && nativeDay.opening === 100 && nativeDay.closing === 98.5)
  check('native 账本 complete=true（起点贴 00:00 且末尾贴次日）', Boolean(nativeDay) && nativeDay.complete === true)
  completeProbe.dispose()

  // 充值 + 乱序样本
  {
    const cacheFile = join(tmpDir, 'native-charge-2.json')
    const service = fakeBalanceService([100, 99, 50, 150, 149])
    const probe = createAccountProbe(fakeCtx(fakeWebServer(), service), { cacheFile, refreshIntervalMs: 60_000 })
    let clock = dayStart
    Date.now = () => clock
    try {
      clock = dayStart + 60_000
      await probe.refresh() // 100
      clock = dayStart + 120_000
      await probe.refresh() // 99 → debit 1
      clock = dayStart + 90_000 // 乱序，应被忽略
      await probe.refresh() // 50
      clock = dayStart + 180_000
      await probe.refresh() // 150 → credit 51
      clock = dayStart + 240_000
      await probe.refresh() // 149 → debit 1
      const ledger = probe.dailyLedger()
      const row = ledger.days[0]
      check('native 充值不计消费（debit=2, credit=51）', Boolean(row) && row.debit === 2 && row.credit === 51, row && `debit=${row.debit} credit=${row.credit}`)
      check('native 乱序样本被忽略（cost=2）', Boolean(row) && row.cost === 2, row && `cost=${row.cost}`)
      check('native 充值日 opening=100 closing=149', Boolean(row) && row.opening === 100 && row.closing === 149)
      probe.dispose()
    } finally {
      Date.now = realDateNow
    }
  }

  // 跨零点：新一天 opening 继承上一天 last（99），且首笔消费记入新日。
  {
    const cacheFile = join(tmpDir, 'native-midnight.json')
    const service = fakeBalanceService([100, 99, 98.5])
    const probe = createAccountProbe(fakeCtx(fakeWebServer(), service), { cacheFile, refreshIntervalMs: 60_000 })
    let clock = dayStart
    Date.now = () => clock
    try {
      clock = dayStart + 60_000
      await probe.refresh() // 100
      clock = dayStart + 120_000
      await probe.refresh() // 99 → day1 debit 1
      clock = dayStart + 86_400_000 + 60_000
      await probe.refresh() // 98.5 → day2 opening 99 → debit 0.5
      const ledger = probe.dailyLedger()
      check('跨零点共 2 天', ledger.days.length === 2, `days=${ledger.days.length}`)
      const second = ledger.days[1]
      check('跨零点次日 opening = 上日 last（99）', Boolean(second) && second.opening === 99, second && `opening=${second.opening}`)
      check('跨零点次日 debit=0.5', Boolean(second) && second.debit === 0.5, second && `debit=${second.debit}`)
      const first = ledger.days[0]
      check('跨零点首日 complete=false（末尾距 00:00 太远）', Boolean(first) && first.complete === false)
      check('跨零点次日 complete=true（起点 00:01 在 10 分钟容差内）', Boolean(second) && second.complete === true)
      probe.dispose()
    } finally {
      Date.now = realDateNow
    }
  }

  // v1 → v2 迁移：从已有 samples 回放生成 days。
  {
    const cacheFile = join(tmpDir, 'native-migrate.json')
    const d1 = dayStart - 2 * 86_400_000
    const d2 = dayStart - 86_400_000
    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 1,
        installedAt: d1 + 60_000,
        savedAt: d2 + 90_000,
        samples: [
          { at: d1 + 60_000, total: 100, recharge: 100, bonus: 0, currency: 'CNY' },
          { at: d1 + 3_600_000, total: 99, recharge: 100, bonus: 0, currency: 'CNY' },
          { at: d2 + 60_000, total: 98.5, recharge: 100, bonus: 0, currency: 'CNY' },
        ],
      }),
      'utf8',
    )
    const probe = createAccountProbe(fakeCtx(fakeWebServer(), null), { cacheFile, refreshIntervalMs: 60_000 })
    probe.start()
    const ledger = probe.dailyLedger()
    report.migration = { days: ledger.days.length, keys: ledger.days.map((row) => row.day) }
    check('v1 缓存迁移出 2 天账本', ledger.days.length === 2, `days=${ledger.days.length}`)
    const migrated1 = ledger.days[0]
    const migrated2 = ledger.days[1]
    check('v1 迁移首日 cost=1', Boolean(migrated1) && migrated1.cost === 1, migrated1 && `cost=${migrated1.cost}`)
    check('v1 迁移次日 opening=99 cost=0.5', Boolean(migrated2) && migrated2.opening === 99 && migrated2.cost === 0.5, migrated2 && `opening=${migrated2.opening} cost=${migrated2.cost}`)
    probe.dispose()
  }

  // 双源日观测级合并（v6.1，契约 §7.8）：整行二选一会丢「更早起点」或「更晚终点」。
  const unitsOf = (cny) => Math.round(cny * 1e8)
  const yesterdayKey = beijingKey(dayStart - 86_400_000)
  const day2Key = beijingKey(dayStart - 2 * 86_400_000)
  const day2Start = dayStart - 2 * 86_400_000
  const nativeDaysFake = [
    // 今天：native 窗口 00:01 → 01:00（100 → 98.5）。
    {
      day: todayKeyNative,
      cost: 1.5,
      debit: 1.5,
      credit: 0,
      opening: 100,
      closing: 98.5,
      firstAt: dayStart + 60_000,
      lastAt: dayStart + 3_600_000,
      complete: true,
    },
    // 昨天：native 窗口 00:30 → 01:00（60 → 120，中间有充值）。
    {
      day: yesterdayKey,
      cost: 0,
      debit: 0,
      credit: 60,
      opening: 60,
      closing: 120,
      firstAt: dayStart - 86_400_000 + 30 * 60_000,
      lastAt: dayStart - 86_400_000 + 60 * 60_000,
      complete: true,
    },
    // 前天：native 与 whale 的 firstAt/lastAt 完全相同（用于验证不重复计 delta）。
    {
      day: day2Key,
      cost: 0,
      debit: 0,
      credit: 0,
      opening: 100,
      closing: 100,
      firstAt: day2Start + 5 * 60_000,
      lastAt: day2Start + 5 * 60_000,
      complete: true,
    },
  ]
  writeFileSync(
    join(tmpDir, 'dual-whale.json'),
    JSON.stringify({
      accounting: {
        version: 1,
        active: 'k-CNY',
        books: {
          'k-CNY': {
            currency: 'CNY',
            days: {
              [todayKeyNative]: {
                day: todayKeyNative,
                firstAt: dayStart + 50_000,
                lastAt: dayStart + 2 * 3_600_000,
                openingUnits: unitsOf(74.194522),
                lastUnits: unitsOf(51.419121),
                debitUnits: unitsOf(74.194522) - unitsOf(51.419121),
                creditUnits: 0,
              },
              [yesterdayKey]: {
                day: yesterdayKey,
                firstAt: dayStart - 86_400_000 + 10_000,
                lastAt: dayStart - 86_400_000 + 90 * 60_000,
                openingUnits: unitsOf(100),
                lastUnits: unitsOf(50),
                debitUnits: unitsOf(50),
                creditUnits: 0,
              },
              [day2Key]: {
                day: day2Key,
                firstAt: day2Start + 5 * 60_000,
                lastAt: day2Start + 30 * 60_000,
                openingUnits: unitsOf(80),
                lastUnits: unitsOf(90),
                debitUnits: 0,
                creditUnits: unitsOf(10),
              },
            },
          },
        },
      },
    }),
    'utf8',
  )
  const mergedProbe = createBillHistory({
    file: join(tmpDir, 'dual-whale.json'),
    cacheFile: join(tmpDir, 'dual-cache.json'),
    native: () => ({ source: 'usage-monitor', currency: 'CNY', scopeTag: 'account', days: nativeDaysFake }),
  })
  const mergedView = mergedProbe.snapshot({ range: 'all' })
  report.merged = mergedView
  validateBillHistory(mergedView, 'billHistory.merged')
  check('合并 source=monitor+whale', mergedView.source === 'monitor+whale', mergedView.source)
  check('合并 nativeDays=3 whaleDays=3', mergedView.freshness.nativeDays === 3 && mergedView.freshness.whaleDays === 3, JSON.stringify(mergedView.freshness))

  // 今天：双源合成 → opening 取 whale 最早窗口、closing 取最晚窗口、debit 覆盖中间净下降。
  const mergedToday = dayOf(mergedView, todayKeyNative)
  check('双源日 origin=monitor+whale', Boolean(mergedToday) && mergedToday.origin === 'monitor+whale', mergedToday && `origin=${mergedToday.origin}`)
  check(
    '双源日 opening = 最早窗口（whale 74.194522）',
    Boolean(mergedToday) && Math.abs(mergedToday.opening - 74.194522) < 1e-9,
    mergedToday && `opening=${mergedToday.opening}`,
  )
  check(
    '双源日 closing = 最新窗口（whale 51.419121）',
    Boolean(mergedToday) && Math.abs(mergedToday.closing - 51.419121) < 1e-9,
    mergedToday && `closing=${mergedToday.closing}`,
  )
  check(
    '双源日 firstAt/lastAt 来自各自端点',
    Boolean(mergedToday) && mergedToday.firstAt === dayStart + 50_000 && mergedToday.lastAt === dayStart + 2 * 3_600_000,
    mergedToday && `firstAt=${mergedToday.firstAt} lastAt=${mergedToday.lastAt}`,
  )
  check(
    '双源日 debit = 中间净下降之和（48.580879）',
    Boolean(mergedToday) && Math.abs(mergedToday.debit - 48.580879) < 1e-9,
    mergedToday && `debit=${mergedToday.debit}`,
  )
  check(
    '双源日 credit = 中间净上升之和（25.805478）',
    Boolean(mergedToday) && Math.abs(mergedToday.credit - 25.805478) < 1e-9,
    mergedToday && `credit=${mergedToday.credit}`,
  )
  check('双源日 cost = debit', Boolean(mergedToday) && mergedToday.cost === mergedToday.debit)

  // 昨天：双源日中间有充值 → debit / credit 各自正确，充值不冲减消费。
  const mergedYesterday = dayOf(mergedView, yesterdayKey)
  check(
    '双源日+充值 debit=110（40+70）、credit=60',
    Boolean(mergedYesterday) && Math.abs(mergedYesterday.debit - 110) < 1e-9 && Math.abs(mergedYesterday.credit - 60) < 1e-9,
    mergedYesterday && `debit=${mergedYesterday.debit} credit=${mergedYesterday.credit}`,
  )
  check('双源日+充值 origin=monitor+whale', Boolean(mergedYesterday) && mergedYesterday.origin === 'monitor+whale')
  check('双源日+充值 opening=100 closing=50', Boolean(mergedYesterday) && mergedYesterday.opening === 100 && mergedYesterday.closing === 50)

  // 前天：两源 at 完全相同 → 同一时刻只保留一条（优先 native），不重复计 delta。
  const mergedDay2 = dayOf(mergedView, day2Key)
  check(
    '双源日 at 相同不重复计 delta（debit=10、无负数）',
    Boolean(mergedDay2) && Math.abs(mergedDay2.debit - 10) < 1e-9 && mergedDay2.debit >= 0,
    mergedDay2 && `debit=${mergedDay2.debit}`,
  )
  check('双源日 at 相同 opening=100 closing=90', Boolean(mergedDay2) && mergedDay2.opening === 100 && mergedDay2.closing === 90)
  check('合并 days 升序且唯一', mergedView.days.every((row, index) => index === 0 || mergedView.days[index - 1].day < row.day))

  // 纯 native（whale 文件缺失）：单来源日期直通，不走观测级合并。
  const nativeOnly = createBillHistory({
    file: join(tmpDir, 'native-only-whale-missing.json'),
    cacheFile: join(tmpDir, 'native-only-cache.json'),
    native: () => ({
      source: 'usage-monitor',
      currency: 'CNY',
      scopeTag: 'account',
      days: [nativeDaysFake[0]],
    }),
  })
  const nativeOnlyView = nativeOnly.snapshot({ range: 'all' })
  report.nativeOnly = nativeOnlyView
  validateBillHistory(nativeOnlyView, 'billHistory.nativeOnly')
  check('纯 native 可用', nativeOnlyView.available === true)
  check('纯 native source=monitor', nativeOnlyView.source === 'monitor', nativeOnlyView.source)
  check('纯 native legacySource=wallet-ledger', nativeOnlyView.legacySource === 'wallet-ledger')
  check('纯 native days=1 且 origin=monitor', nativeOnlyView.days.length === 1 && nativeOnlyView.days[0].origin === 'monitor')
  check('纯 native totals.all.cost=1.5', nativeOnlyView.totals.all.cost === 1.5, `all=${nativeOnlyView.totals.all.cost}`)
  const nativeWindows = nativeOnly.windows()
  check('纯 native windows fresh=true source=monitor', nativeWindows.fresh === true && nativeWindows.source === 'monitor')
  check('纯 native windows spend.today=1.5', nativeWindows.spend.today === 1.5, `today=${nativeWindows.spend.today}`)
  check('纯 native stats.nativeDays=1', nativeOnly.stats().nativeDays === 1)

  const whaleOnlyView = real.snapshot({ range: 'all' })
  report.whaleOnly = { source: whaleOnlyView.source, legacySource: whaleOnlyView.legacySource, days: whaleOnlyView.days.length }
  validateBillHistory(whaleOnlyView, 'billHistory.whaleOnly')
  check('只有 whale source=whale', whaleOnlyView.source === 'whale', whaleOnlyView.source)
  check('只有 whale days 行 origin=whale', whaleOnlyView.days.every((row) => row.origin === 'whale'))

  const emptyLedger = createBillHistory({
    file: join(tmpDir, 'none-whale.json'),
    cacheFile: join(tmpDir, 'none-cache.json'),
    native: () => null,
  })
  const emptyView = emptyLedger.snapshot({ range: 'all' })
  validateBillHistory(emptyView, 'billHistory.empty')
  check('两源都没有 available:false', emptyView.available === false)
  check('两源都没有 diag 非空', typeof emptyView.diag === 'string' && emptyView.diag.length > 0, emptyView.diag)

  const brokenFile = join(tmpDir, 'broken-whale.json')
  writeFileSync(brokenFile, '{not json', 'utf8')
  let brokenThrew = false
  let brokenView = null
  try {
    const brokenProbe = createBillHistory({ file: brokenFile, cacheFile: join(tmpDir, 'broken-cache.json'), native: () => null })
    brokenView = brokenProbe.snapshot({ range: 'all' })
    brokenProbe.dispose()
  } catch {
    brokenThrew = true
  }
  check('损坏 whale JSON 不抛', brokenThrew === false)
  validateBillHistory(brokenView, 'billHistory.broken')
  check('损坏 whale JSON available:false', brokenView.available === false)
  nativeOnly.dispose()
  mergedProbe.dispose()
  emptyLedger.dispose()

  // 清理
  real.dispose()
  missingProbe.dispose()
  cacheProbe.dispose()
  restartProbe.dispose()
  routeBillHistory.dispose()
  ledgerProbe.dispose()
  staleProbe.dispose()
  offlineProbe.dispose()
  let idempotent = true
  try {
    real.dispose()
    real.dispose()
  } catch {
    idempotent = false
  }
  check('dispose 幂等', idempotent)
  rmSync(tmpDir, { recursive: true, force: true })
  check('临时目录已清理', !existsSync(tmpDir))

  report.passed = passed
  report.failures = failures
  report.ok = failures.length === 0
  return report
}

/** 异步调用一个路由，返回 {status, body}。 */
async function callRouteAsync(routes, path, query) {
  const handler = routes.get(`${BASE}${path}`)
  check(`路由 ${path} 已注册`, typeof handler === 'function')
  if (typeof handler !== 'function') return { status: 0, body: null }
  const { res, captured } = fakeResponse()
  const req = {
    method: 'GET',
    url: `/usage-monitor/api${path}${query ? `?${query}` : ''}`,
    headers: { host: '127.0.0.1:11331' },
  }
  try {
    await handler(req, res)
  } catch (error) {
    captured.body = { thrown: String(error && error.message ? error.message : error) }
  }
  return captured
}

const report = await run()
console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) {
  console.error(`\nbill-history-check FAILED — ${passed} passed, ${failures.length} failed`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exitCode = 1
} else {
  console.log(`\nbill-history-check PASSED — ${passed} assertions`)
}
