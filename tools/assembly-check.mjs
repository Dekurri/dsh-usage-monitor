/**
 * dsh-usage-monitor — Host 装配冒烟自测（真实 index.js + 真实 lib/*，只 stub Host 服务）。
 *
 * 运行：  node tools/assembly-check.mjs
 * 退出码：0 = 全绿；1 = 失败。
 *
 * 目的：在插件真正安装到 profile 之前，验证 Lead 写的 `index.js` 与 v2 三个模块的
 * 装配契约对得上：服务注入、extras 传参、start 顺序、7 条路由、dispose 链、以及
 * 「没有 llm / 没有 deepseekAccount 时也绝不崩」的降级路径。
 *
 * 覆盖：
 *  1. `apply(ctx, settings)` 正常装配：7 条 exact 路由、collector 扫描空库、ledger 监听挂上、
 *     account 立即 refresh（sampledAt>0）；
 *  2. `GET /overview`、`/live`、`/ledger`、`/account` 全部 200 且契约字段齐全；
 *  3. 模拟一次 `llm/stream` 调用后 `/ledger` 的 totals.requests 增长；
 *  4. `POST /account/login` 返回 authorizeUrl；
 *  5. 降级：`ctx.get('llm')` / `ctx.get('deepseekAccount')` 为 undefined 时全路由仍 200、不抛；
 *  6. `ctx.effect` 的清理函数调用后：路由 disposers 被调用、定时器被 unref/清除、再访问不崩。
 *
 * 只写包内 .tmp/（本机 os.tmpdir() 不可用，EPERM），结束后清理。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'
import { BASE } from '../lib/routes.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, '..', '.tmp', 'assembly-check')

let passed = 0
const failures = []

function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    return true
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  return false
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

function fakeReq(method, url) {
  return { method, url, headers: { host: '127.0.0.1:11331' } }
}

function json(res) {
  try {
    return JSON.parse(res.body)
  } catch {
    return null
  }
}

/**
 * 造一个最小 Host ctx。
 * @param {{hasLlm?: boolean, hasAccount?: boolean, listSessions?: Function}} options
 */
function makeHostCtx(options) {
  const settings = options || {}
  const routes = []
  const routeDisposers = []
  const listeners = new Map()
  const effects = []
  let routeDisposed = 0
  const collectorLog = { listSessions: 0, observeSession: 0 }

  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          routeDisposed += 1
        }
      },
    },
    sessionQuery: {
      async listSessions() {
        collectorLog.listSessions += 1
        return typeof settings.listSessions === 'function' ? settings.listSessions() : []
      },
      async observeSession() {
        collectorLog.observeSession += 1
        throw new Error('assembly-check: no sessions expected')
      },
    },
    sessions: { list: () => [] },
    get(name) {
      if (name === 'llm' && settings.hasLlm !== false) return { name: 'fake-llm' }
      if (name === 'deepseekAccount' && settings.hasAccount !== false) {
        return {
          async getState() {
            return {
              status: 'credential-stored',
              links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
              attempt: null,
            }
          },
          async getBalance() {
            return { status: 'ready', value: [{ currency: 'CNY', balance: '70.69' }], bonusWallets: [] }
          },
          async startSignIn() {
            return {
              status: 'credential-stored',
              links: { usageUrl: 'u', topUpUrl: 't' },
              attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/authorize?code=abc' },
            }
          },
        }
      }
      return undefined
    },
    on(name, listener) {
      listeners.set(name, listener)
      return () => {
        listeners.delete(name)
      }
    },
    effect(execute) {
      const cleanup = typeof execute === 'function' ? execute() : undefined
      effects.push(() => {
        if (typeof cleanup === 'function') cleanup()
      })
    },
    logger() {
      return { error: () => {}, warn: () => {}, info: () => {} }
    },
  }

  const host = {
    ctx,
    routes,
    routeDisposers,
    listeners,
    collectorLog,
    get routeDisposed() {
      return routeDisposed
    },
    disposeAll() {
      for (const cleanup of effects.splice(0).reverse()) cleanup()
    },
  }
  return host
}

function routeOf(host, tail) {
  return host.routes.find((route) => route.path === `${BASE}/${tail}`)
}

async function callRoute(host, tail, method, url) {
  const route = routeOf(host, tail)
  if (!route) return null
  const res = fakeRes()
  await route.handler(fakeReq(method, url || `${BASE}/${tail}`), res)
  return res
}

async function scenarioHealthy() {
  rmSync(join(TMP, 'healthy'), { recursive: true, force: true })
  mkdirSync(join(TMP, 'healthy'), { recursive: true })
  // 历史账本 fixture：两天 × 1e8 units（1 CNY = 1e8 units）。
  writeFileSync(
    join(TMP, 'healthy', 'ledger-source.json'),
    JSON.stringify({
      accounting: {
        version: 1,
        books: {
          'k-CNY': {
            currency: 'CNY',
            days: {
              '2026-10-24': { day: '2026-10-24', firstAt: 0, lastAt: 0, openingUnits: 0, lastUnits: 0, debitUnits: 0, creditUnits: 0 },
              '2026-10-25': { day: '2026-10-25', firstAt: 0, lastAt: 0, openingUnits: 0, lastUnits: 0, debitUnits: 1740764900, creditUnits: 0 },
            },
          },
        },
      },
    }),
    'utf8',
  )
  const host = makeHostCtx({})
  apply(host.ctx, {
    cacheFile: join(TMP, 'healthy', 'cache.json'),
    ledgerFile: join(TMP, 'healthy', 'llm-ledger.json'),
    accountFile: join(TMP, 'healthy', 'account.json'),
    billHistoryFile: join(TMP, 'healthy', 'ledger-source.json'),
    billHistoryCacheFile: join(TMP, 'healthy', 'bill-history-cache.json'),
    // v4：汇率缓存写测试目录，避免碰真实 $DSH_HOME/usage-monitor。
    fxFile: join(TMP, 'healthy', 'fx.json'),
    fxRefreshIntervalMs: 1800000,
    fx: { USDCNY: 7.1 },
    sampleIntervalMs: 2000,
    liveHistoryPoints: 60,
    rescanIntervalMs: 60000,
    accountRefreshIntervalMs: 60000,
  })

  ok('装配: 注册 7 条 exact 路由', host.routes.length === 7, host.routes.length)
  ok('装配: 注册了 llm/stream 监听', typeof host.listeners.get('llm/stream') === 'function')
  await sleep(60) // 等 account 首次 refresh 与 collector 首次扫描完成

  // v1 路由仍然工作（空库 → 0 会话）。
  let res = await callRoute(host, 'overview', 'GET', `${BASE}/overview?range=24h&currency=USD`)
  ok('路由: GET /overview 200', res && res.statusCode === 200, res && res.statusCode)
  const overview = json(res)
  ok('路由: /overview kpi 存在', overview && overview.kpi && Number.isFinite(overview.kpi.totalTokens))
  ok('路由: /overview 空库 sessions=0', overview && overview.kpi.sessions === 0, overview && overview.kpi.sessions)
  res = await callRoute(host, 'live', 'GET')
  const live = json(res)
  ok('路由: GET /live 200', res && res.statusCode === 200)
  ok('路由: /live history 60 点', live && Array.isArray(live.history.cpu) && live.history.cpu.length === 60, live && live.history && live.history.cpu.length)

  // ledger：模拟一次真实 llm/stream（带 usage）后应记账。
  const listener = host.listeners.get('llm/stream')
  const chunks = [
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'usage', usage: { inputTokens: 2000, outputTokens: 300, cacheReadTokens: 8000 } },
    { type: 'finish', reason: 'stop' },
  ]
  const iterator = {
    index: 0,
    async next() {
      if (this.index >= chunks.length) return { done: true, value: undefined }
      return { done: false, value: chunks[this.index++] }
    },
    async return() {
      return { done: true, value: undefined }
    },
  }
  const upstream = { [Symbol.asyncIterator]: () => iterator, return: (value) => iterator.return(value) }
  const wrapped = listener({ provider: 'deepseek-account', model: 'deepseek-flash' }, () => upstream)
  const seen = []
  for await (const chunk of wrapped) seen.push(chunk)
  ok('装配: llm/stream chunk 原样转发', seen.length === 3 && seen[2] === chunks[2])

  res = await callRoute(host, 'ledger', 'GET', `${BASE}/ledger?range=all`)
  const ledgerView = json(res)
  ok('路由: GET /ledger 200', res && res.statusCode === 200)
  ok('路由: /ledger available=true', ledgerView && ledgerView.available === true)
  ok('路由: /ledger 收到 llm 调用（requests=1）', ledgerView && ledgerView.totals.requests === 1, ledgerView && ledgerView.totals.requests)
  ok('路由: /ledger totalTokens=10300', ledgerView && ledgerView.totals.totalTokens === 10300, ledgerView && ledgerView.totals.totalTokens)
  ok('路由: /ledger 契约字段齐全', ['generatedAt', 'available', 'installedAt', 'range', 'totals', 'byPurpose', 'byModel', 'byHour', 'recent', 'missing', 'diag'].every((key) => Object.prototype.hasOwnProperty.call(ledgerView, key)))

  res = await callRoute(host, 'account', 'GET')
  const accountView = json(res)
  ok('路由: GET /account 200', res && res.statusCode === 200)
  ok('路由: /account signedIn=true', accountView && accountView.signedIn === true, accountView && accountView.signedIn)
  ok('路由: /account balance=70.69', accountView && accountView.balance && Math.abs(accountView.balance.total - 70.69) < 1e-9, accountView && accountView.balance && accountView.balance.total)
  ok('路由: /account spend 四窗口存在', accountView && accountView.spend && ['today', 'yesterday', 'last7d', 'last30d'].every((key) => Object.prototype.hasOwnProperty.call(accountView.spend, key)))
  res = await callRoute(host, 'bill-history', 'GET', `${BASE}/bill-history?range=all`)
  const billView = json(res)
  ok('路由: GET /bill-history 200', res && res.statusCode === 200, res && res.statusCode)
  ok('路由: /bill-history available=true', billView && billView.available === true, billView && billView.diag)
  // v6：合并 native 自建账本（本进程采样出来的「今天」1 天）+ whale fixture（2 天）= 3 天。
  ok(
    '路由: /bill-history 读到 2 天 whale + 1 天 native',
    billView && Array.isArray(billView.days) && billView.days.length === 3,
    billView && billView.days && billView.days.length,
  )
  ok('路由: /bill-history source=monitor+whale', billView && billView.source === 'monitor+whale', billView && billView.source)
  ok(
    '路由: /bill-history 每天带 origin 且含 monitor 天',
    billView &&
      Array.isArray(billView.days) &&
      billView.days.every((row) => row.origin === 'monitor' || row.origin === 'whale' || row.origin === 'monitor+whale') &&
      billView.days.some((row) => row.origin === 'monitor' || row.origin === 'monitor+whale'),
    billView && billView.days && billView.days.map((row) => row.origin).join(','),
  )
  ok('路由: /bill-history 契约字段齐全', billView && ['generatedAt', 'available', 'source', 'legacySource', 'currency', 'range', 'days', 'since', 'until', 'totals', 'freshness', 'diag'].every((key) => Object.prototype.hasOwnProperty.call(billView, key)))
  // v4 汇率路由：模块在装配时创建，永远返回 200（未联网时用配置兜底值 + stale）。
  res = await callRoute(host, 'fx', 'GET')
  const fxView = json(res)
  ok('路由: GET /fx 200', res && res.statusCode === 200, res && res.statusCode)
  ok('路由: /fx available', fxView && fxView.available === true, fxView && fxView.diag)
  ok('路由: /fx rate>0', fxView && Number.isFinite(fxView.rate) && fxView.rate > 0, fxView && fxView.rate)
  ok('路由: /fx 契约字段齐全', fxView && ['generatedAt', 'available', 'rate', 'currency', 'quote', 'source', 'sourceLabel', 'effectiveDate', 'fetchedAt', 'stale', 'diag'].every((key) => Object.prototype.hasOwnProperty.call(fxView, key)))

  res = await callRoute(host, 'account/login', 'POST')
  const login = json(res)
  ok('路由: POST /account/login 200', res && res.statusCode === 200, res && res.statusCode)
  ok('路由: login 返回 authorizeUrl', login && typeof login.authorizeUrl === 'string' && login.authorizeUrl.startsWith('https://'))
  ok('路由: login 返回 phase', login && typeof login.phase === 'string')

  // 方法校验
  res = await callRoute(host, 'ledger', 'POST')
  ok('路由: POST /ledger → 405', res && res.statusCode === 405, res && res.statusCode)

  // 清理：ctx.effect 的清理函数（index.js 的 disposer 链）。
  host.disposeAll()
  await sleep(20)
  ok('装配: dispose 调用了路由 disposer', host.routeDisposed === 7, host.routeDisposed)
  ok('装配: dispose 摘掉了 llm/stream 监听', host.listeners.get('llm/stream') === undefined)
  return host
}

async function scenarioDegraded() {
  rmSync(join(TMP, 'degraded'), { recursive: true, force: true })
  mkdirSync(join(TMP, 'degraded'), { recursive: true })
  const host = makeHostCtx({ hasLlm: false, hasAccount: false })
  apply(host.ctx, {
    cacheFile: join(TMP, 'degraded', 'cache.json'),
    ledgerFile: join(TMP, 'degraded', 'llm-ledger.json'),
    accountFile: join(TMP, 'degraded', 'account.json'),
    billHistoryFile: join(TMP, 'degraded', 'missing-ledger.json'),
    billHistoryCacheFile: join(TMP, 'degraded', 'bill-history-cache.json'),
    fxFile: join(TMP, 'degraded', 'fx.json'),
    fxRefreshIntervalMs: 1800000,
  })
  await sleep(40)
  ok('降级: 仍注册 7 条路由', host.routes.length === 7, host.routes.length)
  let res = await callRoute(host, 'ledger', 'GET', `${BASE}/ledger?range=7d`)
  const ledgerView = json(res)
  ok('降级: GET /ledger 200（不 500）', res && res.statusCode === 200, res && res.statusCode)
  ok('降级: /ledger available=false', ledgerView && ledgerView.available === false)
  ok('降级: /ledger diag 非空', ledgerView && typeof ledgerView.diag === 'string' && ledgerView.diag.length > 0)
  res = await callRoute(host, 'account', 'GET')
  const accountView = json(res)
  ok('降级: GET /account 200（不 500）', res && res.statusCode === 200, res && res.statusCode)
  ok('降级: /account available=false', accountView && accountView.available === false)
  res = await callRoute(host, 'bill-history', 'GET', `${BASE}/bill-history?range=7d`)
  const billView = json(res)
  ok('降级: GET /bill-history 200（不 500）', res && res.statusCode === 200, res && res.statusCode)
  ok('降级: /bill-history available=false', billView && billView.available === false, billView && billView.diag)
  res = await callRoute(host, 'fx', 'GET')
  const fxView = json(res)
  ok('降级: GET /fx 200（不 500）', res && res.statusCode === 200, res && res.statusCode)
  ok('降级: /fx rate>0', fxView && Number.isFinite(fxView.rate) && fxView.rate > 0, fxView && fxView.rate)
  res = await callRoute(host, 'account/login', 'POST')
  ok('降级: POST /account/login 500 但不崩', res && res.statusCode === 500, res && res.statusCode)
  host.disposeAll()
}

/** v6：只有 native 自建账本、没有 whale 文件时，`/bill-history` 仍应 200 + available:true + source=monitor。 */
async function scenarioNativeOnly() {
  rmSync(join(TMP, 'native-only'), { recursive: true, force: true })
  mkdirSync(join(TMP, 'native-only'), { recursive: true })
  const host = makeHostCtx({ hasLlm: false, hasAccount: true })
  apply(host.ctx, {
    cacheFile: join(TMP, 'native-only', 'cache.json'),
    ledgerFile: join(TMP, 'native-only', 'llm-ledger.json'),
    accountFile: join(TMP, 'native-only', 'account.json'),
    billHistoryFile: join(TMP, 'native-only', 'missing-ledger.json'),
    billHistoryCacheFile: join(TMP, 'native-only', 'bill-history-cache.json'),
    fxFile: join(TMP, 'native-only', 'fx.json'),
    fxRefreshIntervalMs: 1800000,
    accountRefreshIntervalMs: 60000,
  })
  await sleep(100) // 等 account 首次 getBalance 采样写入 native 账本
  const res = await callRoute(host, 'bill-history', 'GET', `${BASE}/bill-history?range=all`)
  const view = json(res)
  ok('native-only: GET /bill-history 200（不 500）', res && res.statusCode === 200, res && res.statusCode)
  ok('native-only: /bill-history available=true', view && view.available === true, view && view.diag)
  ok('native-only: source=monitor', view && view.source === 'monitor', view && view.source)
  ok('native-only: 至少 1 天且 origin=monitor', view && Array.isArray(view.days) && view.days.length >= 1 && view.days.every((row) => row.origin === 'monitor'), view && view.days && view.days.length)
  ok('native-only: totals.all.cost ≥ 0', view && view.totals && Number.isFinite(view.totals.all.cost) && view.totals.all.cost >= 0)
  host.disposeAll()
}

async function main() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  await scenarioHealthy()
  await scenarioDegraded()
  await scenarioNativeOnly()
  rmSync(TMP, { recursive: true, force: true })
  if (failures.length > 0) {
    console.error(`ASSEMBLY CHECK FAILED — ${failures.length} failed / ${passed} passed`)
    for (const failure of failures) console.error(`  ✗ ${failure}`)
    process.exitCode = 1
    return
  }
  console.log(`ASSEMBLY CHECK PASSED — ${passed} assertions`)
}

main().catch((error) => {
  console.error('ASSEMBLY CHECK CRASHED:', error && error.stack ? error.stack : error)
  process.exitCode = 1
})
