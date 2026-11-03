/**
 * dsh-usage-monitor — v2 账号余额探针自测（task-3 验收 ③ / ④ + 余额差法 + 路由 + 持久化）。
 *
 * 运行：  node tools/account-check.mjs
 * 退出码：0 = 全绿；1 = 有失败。
 *
 * 覆盖：
 *  1. 已登录：假 deepseekAccount 返回 `{status:'ready', value:[{currency:'CNY',balance:'70.69'}]}` →
 *     /account 输出 balance.total=70.69、signedIn=true、links 透传；
 *  2. 只有赠金也算成功（value 空、bonusWallets 非空）；
 *  3. 未登录：getState → signed-out → available:true + signedIn:false + 余额全 0，不含假数据；
 *  4. 无账号服务 / getBalance 抛错：available:false（或 signedIn:true 无余额）+ diag，绝不抛；
 *  5. 余额差法：两次刷新余额 100 → 96.5 得 spend.today=3.5；余额上升（充值）→ hasTopUp=true、spend=null；
 *  6. startSignIn 返回 authorizeUrl/phase；无服务时 reject 且带 diag；
 *  7. 持久化：dispose 落盘（原子写、无 .tmp 残留）→ 新实例读回采样；
 *  8. 路由：GET /account 200 + 契约 §7.4 全字段；POST /account/login 200 / 失败 500；extras=null 时
 *     /account 返回 available:false 的合法视图、login 返回 500 而不是崩溃。
 *
 * 只写包内 .tmp/（本机 os.tmpdir() 不可用，EPERM），结束后清理。
 */

import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAccountProbe } from '../lib/account.js'
import { registerUsageRoutes, BASE } from '../lib/routes.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, '..', '.tmp', 'account-check')
const CACHE = join(TMP, 'account.json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

function near(actual, expected, epsilon = 1e-9) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon
}

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

function fakeReq(method, url, headers) {
  return { method, url, headers: headers || { host: '127.0.0.1:11331' } }
}

/** 契约 §7.4 视图字段/类型校验。 */
function validateAccountView(view, label) {
  const prefix = `account:${label}`
  ok(`${prefix}: 对象`, view && typeof view === 'object')
  for (const key of ['generatedAt', 'available', 'signedIn', 'currency', 'balance', 'sampledAt', 'usageUrl', 'topUpUrl', 'spend', 'hasTopUp', 'diag']) {
    ok(`${prefix}: 字段 ${key}`, Object.prototype.hasOwnProperty.call(view, key))
  }
  ok(`${prefix}: generatedAt 数字`, Number.isFinite(view.generatedAt))
  ok(`${prefix}: available 布尔`, typeof view.available === 'boolean')
  ok(`${prefix}: signedIn 布尔`, typeof view.signedIn === 'boolean')
  ok(`${prefix}: currency ∈ CNY/USD`, view.currency === 'CNY' || view.currency === 'USD')
  for (const key of ['total', 'recharge', 'bonus']) ok(`${prefix}: balance.${key} 有限`, Number.isFinite(view.balance && view.balance[key]))
  ok(`${prefix}: sampledAt 有限`, Number.isFinite(view.sampledAt))
  ok(`${prefix}: usageUrl 字符串`, typeof view.usageUrl === 'string')
  ok(`${prefix}: topUpUrl 字符串`, typeof view.topUpUrl === 'string')
  for (const key of ['today', 'yesterday', 'last7d', 'last30d']) {
    const value = view.spend && view.spend[key]
    ok(`${prefix}: spend.${key} = null 或有限数字`, value === null || Number.isFinite(value), String(value))
  }
  ok(`${prefix}: hasTopUp 布尔`, typeof view.hasTopUp === 'boolean')
  ok(`${prefix}: diag 字符串`, typeof view.diag === 'string')
}

/** 造一个可变行为的假 deepseekAccount 服务。 */
function makeFakeService(behaviour) {
  const state = behaviour || {}
  return {
    calls: { getState: 0, getBalance: 0, startSignIn: 0 },
    async getState() {
      this.calls.getState += 1
      if (state.getStateError) throw state.getStateError
      return state.getStateResult ?? {
        status: 'signed-out',
        links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
        attempt: null,
      }
    },
    async getBalance() {
      this.calls.getBalance += 1
      if (state.getBalanceError) throw state.getBalanceError
      return typeof state.getBalanceResult === 'function' ? state.getBalanceResult() : state.getBalanceResult
    },
    async startSignIn(client, callbackOrigin, loginSource) {
      this.calls.startSignIn += 1
      this.lastStartSignIn = { client, callbackOrigin, loginSource }
      if (state.startSignInError) throw state.startSignInError
      return (
        state.startSignInResult ?? {
          status: 'credential-stored',
          links: { usageUrl: 'u', topUpUrl: 't' },
          attempt: { id: 'attempt-1', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/authorize?code=abc' },
        }
      )
    },
  }
}

function ctxWith(service) {
  return {
    get(name) {
      return name === 'deepseekAccount' ? service : undefined
    },
  }
}

async function main() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })

  // -------------------------------------- ③ 已登录 + 余额（验收正例）
  let balance = { status: 'ready', value: [{ currency: 'CNY', balance: '70.69' }], bonusWallets: [] }
  const service = makeFakeService({
    getStateResult: {
      status: 'credential-stored',
      links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
      attempt: null,
    },
    getBalanceResult: () => balance,
    startSignInResult: {
      status: 'credential-stored',
      links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
      attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/authorize?code=abc' },
    },
  })
  const probe = createAccountProbe(ctxWith(service), { cacheFile: CACHE, refreshIntervalMs: 60_000 })
  // 用 getState/getBalance 计数前占位：refresh 前没有 IO
  ok('构造期: 无 IO（getState 调用 0 次）', service.calls.getState === 0, service.calls.getState)
  probe.start()
  await probe.refresh()
  let view = probe.getView()
  validateAccountView(view, 'signed-in')
  ok('已登录: available=true', view.available === true)
  ok('已登录: signedIn=true', view.signedIn === true)
  ok('已登录: currency=CNY', view.currency === 'CNY')
  ok('已登录: balance.total=70.69', near(view.balance.total, 70.69), view.balance.total)
  ok('已登录: recharge=70.69', near(view.balance.recharge, 70.69), view.balance.recharge)
  ok('已登录: bonus=0', near(view.balance.bonus, 0), view.balance.bonus)
  ok('已登录: sampledAt>0', view.sampledAt > 0, view.sampledAt)
  ok('已登录: usageUrl 透传', view.usageUrl === 'https://platform.deepseek.com/usage', view.usageUrl)
  ok('已登录: topUpUrl 透传', view.topUpUrl === 'https://platform.deepseek.com/top_up')
  ok('已登录: diag 为空', view.diag === '')

  // ----------------------------------- 只有赠金也算成功（文件头坑 3）
  balance = { status: 'ready', value: [], bonusWallets: [{ currency: 'CNY', balance: '5.50' }] }
  await probe.refresh()
  view = probe.getView()
  ok('只有赠金: available=true', view.available === true)
  ok('只有赠金: signedIn=true', view.signedIn === true)
  ok('只有赠金: total=5.5', near(view.balance.total, 5.5), view.balance.total)
  ok('只有赠金: recharge=0', near(view.balance.recharge, 0), view.balance.recharge)
  ok('只有赠金: bonus=5.5', near(view.balance.bonus, 5.5), view.balance.bonus)

  // --------------------------------------------- ⑤ 余额差法：消费
  balance = { status: 'ready', value: [{ currency: 'CNY', balance: '100' }], bonusWallets: [] }
  const spendProbe = createAccountProbe(ctxWith(service), { cacheFile: join(TMP, 'spend.json'), refreshIntervalMs: 60_000 })
  await spendProbe.refresh() // 基线 100
  await sleep(10)
  balance = { status: 'ready', value: [{ currency: 'CNY', balance: '96.5' }], bonusWallets: [] }
  await spendProbe.refresh() // 96.5
  await sleep(10)
  let spendView = spendProbe.getView()
  ok('余额差法: spend.today=3.5', near(spendView.spend.today, 3.5), spendView.spend.today)
  ok('余额差法: hasTopUp=false', spendView.hasTopUp === false)
  // 充值：余额上升 → 该窗口不可信，spend=null + hasTopUp=true
  balance = { status: 'ready', value: [{ currency: 'CNY', balance: '200' }], bonusWallets: [] }
  await spendProbe.refresh()
  spendView = spendProbe.getView()
  ok('充值检测: spend.today=null', spendView.spend.today === null, String(spendView.spend.today))
  ok('充值检测: hasTopUp=true', spendView.hasTopUp === true)
  spendProbe.dispose()

  // ------------------------------------------ ④ 未登录 / 服务不存在 / 出错
  const signedOutProbe = createAccountProbe(
    ctxWith(makeFakeService({
      getStateResult: {
        status: 'signed-out',
        links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
        attempt: { id: 'a2', phase: 'expired', errorCode: 'expired' },
      },
    })),
    { cacheFile: join(TMP, 'signed-out.json'), refreshIntervalMs: 60_000 },
  )
  await signedOutProbe.refresh()
  let signedOut = signedOutProbe.getView()
  validateAccountView(signedOut, 'signed-out')
  ok('未登录: available=true', signedOut.available === true)
  ok('未登录: signedIn=false', signedOut.signedIn === false)
  ok('未登录: balance 全 0', signedOut.balance.total === 0 && signedOut.balance.recharge === 0 && signedOut.balance.bonus === 0)
  ok('未登录: sampledAt=0', signedOut.sampledAt === 0)
  ok('未登录: 不含假余额', signedOut.balance.total === 0)
  ok('未登录: attempt.errorCode 进 diag', signedOut.diag.includes('expired'), signedOut.diag)
  signedOutProbe.dispose()

  const noServiceProbe = createAccountProbe(ctxWith(undefined), { cacheFile: join(TMP, 'no-service.json'), refreshIntervalMs: 60_000 })
  await noServiceProbe.refresh()
  const noService = noServiceProbe.getView()
  validateAccountView(noService, 'no-service')
  ok('无服务: available=false', noService.available === false)
  ok('无服务: diag 非空', noService.diag.length > 0, noService.diag)
  ok('无服务: 不抛异常', true)
  noServiceProbe.dispose()

  const errorService = makeFakeService({ getStateError: new Error('boom getState') })
  const errorProbe = createAccountProbe(ctxWith(errorService), { cacheFile: join(TMP, 'error.json'), refreshIntervalMs: 60_000 })
  await errorProbe.refresh()
  const errorView = errorProbe.getView()
  validateAccountView(errorView, 'error')
  ok('getState 抛错: available=false', errorView.available === false)
  ok('getState 抛错: diag 含原因', errorView.diag.includes('boom getState'), errorView.diag)
  errorProbe.dispose()

  balance = { status: 'ready', value: [{ currency: 'CNY', balance: '12' }], bonusWallets: [] }
  const balanceFailService = makeFakeService({
    getStateResult: { status: 'credential-stored', links: { usageUrl: 'u', topUpUrl: 't' }, attempt: null },
    getBalanceError: new Error('boom getBalance'),
  })
  const balanceFailProbe = createAccountProbe(ctxWith(balanceFailService), { cacheFile: join(TMP, 'balance-fail.json'), refreshIntervalMs: 60_000 })
  await balanceFailProbe.refresh()
  const balanceFailView = balanceFailProbe.getView()
  validateAccountView(balanceFailView, 'balance-fail')
  ok('getBalance 抛错: 不抛、余额 0', balanceFailView.balance.total === 0 && balanceFailView.diag.includes('boom getBalance'), balanceFailView.diag)
  balanceFailProbe.dispose()

  // ------------------------------------------------------- startSignIn
  const login = await probe.startSignIn('http://127.0.0.1:11331')
  ok('登录: 返回 authorizeUrl', typeof login.authorizeUrl === 'string' && login.authorizeUrl.startsWith('https://'), login.authorizeUrl)
  ok('登录: 返回 phase', login.phase === 'waiting-browser', login.phase)
  ok('登录: loginSource=web', service.lastStartSignIn && service.lastStartSignIn.loginSource === 'web')
  ok('登录: callbackOrigin 透传', service.lastStartSignIn && service.lastStartSignIn.callbackOrigin === 'http://127.0.0.1:11331')
  ok('登录: clientMeta 有 version/locale/timezoneOffsetSeconds', service.lastStartSignIn && service.lastStartSignIn.client && typeof service.lastStartSignIn.client.version === 'string' && typeof service.lastStartSignIn.client.locale === 'string' && Number.isFinite(service.lastStartSignIn.client.timezoneOffsetSeconds))

  const noServiceLoginProbe = createAccountProbe(ctxWith(undefined), { cacheFile: join(TMP, 'no-service-login.json') })
  let loginError = null
  try {
    await noServiceLoginProbe.startSignIn('http://127.0.0.1:1')
  } catch (error) {
    loginError = error
  }
  ok('登录: 无服务时 reject', loginError instanceof Error, loginError && loginError.message)
  ok('登录: 无服务时带 diag', loginError && typeof loginError.diag === 'string' && loginError.diag.length > 0)
  noServiceLoginProbe.dispose()

  // ---------------------------------------------------- 持久化 + 原子写
  probe.dispose()
  probe.dispose() // 幂等
  ok('持久化: 缓存文件存在', existsSync(CACHE))
  const leftoverTmp = readdirSync(TMP).filter((name) => name.endsWith('.tmp'))
  ok('持久化: 无 .tmp 残留', leftoverTmp.length === 0, leftoverTmp.join(','))
  const probe2 = createAccountProbe(ctxWith(service), { cacheFile: CACHE, refreshIntervalMs: 60_000 })
  probe2.start()
  await probe2.refresh()
  const reloaded = probe2.getView()
  validateAccountView(reloaded, 'reloaded')
  ok('持久化: 读回后仍可用', reloaded.available === true)
  ok('持久化: 读回采样条数 > 0', probe2.stats().samples > 0, probe2.stats().samples)
  probe2.dispose()

  // ------------------------------------------------------------- 路由
  const service2 = makeFakeService({
    getStateResult: { status: 'credential-stored', links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' }, attempt: null },
    getBalanceResult: { status: 'ready', value: [{ currency: 'CNY', balance: '70.69' }], bonusWallets: [] },
    startSignInResult: { status: 'credential-stored', links: { usageUrl: 'u', topUpUrl: 't' }, attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/authorize?code=abc' } },
  })
  const routeProbe = createAccountProbe(ctxWith(service2), { cacheFile: join(TMP, 'route.json'), refreshIntervalMs: 60_000 })
  await routeProbe.refresh()

  const disposers = []
  const registered = []
  const routeCtx = { webServer: { register(route) { registered.push(route); return () => {} } } }
  const collectorStub = { getOverview: async () => ({}), getLive: () => ({}) }
  registerUsageRoutes(routeCtx, collectorStub, disposers, { ledger: null, account: routeProbe })
  ok('路由: 注册 7 条 exact 路由', registered.length === 7 && registered.every((route) => route.kind === 'exact'), registered.map((r) => r.path).join(','))
  ok('路由: disposer 收进数组', disposers.length === 7)

  const accountRoute = registered.find((route) => route.path === `${BASE}/account`)
  const loginRoute = registered.find((route) => route.path === `${BASE}/account/login`)

  let res = fakeRes()
  accountRoute.handler(fakeReq('GET', `${BASE}/account`), res)
  ok('路由: GET /account 200', res.statusCode === 200, res.statusCode)
  ok('路由: JSON content-type', res.headers && res.headers['Content-Type'] === 'application/json; charset=utf-8')
  ok('路由: no-store', res.headers && res.headers['Cache-Control'] === 'no-store')
  let body = null
  try {
    body = JSON.parse(res.body)
  } catch {
    body = null
  }
  validateAccountView(body, 'http')
  ok('路由: /account 数据来自探针', body && body.signedIn === true && near(body.balance.total, 70.69), body && body.balance.total)

  res = fakeRes()
  accountRoute.handler(fakeReq('POST', `${BASE}/account`), res)
  ok('路由: 非 GET /account → 405', res.statusCode === 405, res.statusCode)

  res = fakeRes()
  await loginRoute.handler(fakeReq('POST', `${BASE}/account/login`), res)
  ok('路由: POST /account/login 200', res.statusCode === 200, res.statusCode)
  let loginBody = null
  try {
    loginBody = JSON.parse(res.body)
  } catch {
    loginBody = null
  }
  ok('路由: login 返回 authorizeUrl', loginBody && typeof loginBody.authorizeUrl === 'string' && loginBody.authorizeUrl.startsWith('https://'))
  ok('路由: login 返回 phase', loginBody && typeof loginBody.phase === 'string')
  ok('路由: login 用同源 callbackOrigin', service2.lastStartSignIn && service2.lastStartSignIn.callbackOrigin === 'http://127.0.0.1:11331', service2.lastStartSignIn && service2.lastStartSignIn.callbackOrigin)

  res = fakeRes()
  await loginRoute.handler(fakeReq('GET', `${BASE}/account/login`), res)
  ok('路由: GET /account/login → 405', res.statusCode === 405, res.statusCode)

  // extras=null：/account 合法视图 available:false；login 500 但不崩
  const registered2 = []
  const routeCtx2 = { webServer: { register(route) { registered2.push(route); return () => {} } } }
  registerUsageRoutes(routeCtx2, collectorStub, [], null)
  const accountRoute2 = registered2.find((route) => route.path === `${BASE}/account`)
  const loginRoute2 = registered2.find((route) => route.path === `${BASE}/account/login`)
  res = fakeRes()
  accountRoute2.handler(fakeReq('GET', `${BASE}/account`), res)
  ok('路由: extras=null /account 200', res.statusCode === 200, res.statusCode)
  let fallback = null
  try {
    fallback = JSON.parse(res.body)
  } catch {
    fallback = null
  }
  validateAccountView(fallback, 'fallback')
  ok('路由: fallback available=false', fallback.available === false)
  ok('路由: fallback diag 非空', fallback.diag.length > 0)
  res = fakeRes()
  await loginRoute2.handler(fakeReq('POST', `${BASE}/account/login`), res)
  ok('路由: extras=null login → 500', res.statusCode === 500, res.statusCode)
  let loginErrBody = null
  try {
    loginErrBody = JSON.parse(res.body)
  } catch {
    loginErrBody = null
  }
  ok('路由: extras=null login 带 error+diag', loginErrBody && typeof loginErrBody.error === 'string' && typeof loginErrBody.diag === 'string')

  routeProbe.dispose()

  // ---------------------------------------------------------- 汇总
  rmSync(TMP, { recursive: true, force: true })
  if (failures.length > 0) {
    console.error(`ACCOUNT CHECK FAILED — ${failures.length} failed / ${passed} passed`)
    for (const failure of failures) console.error(`  ✗ ${failure}`)
    process.exitCode = 1
    return
  }
  console.log(`ACCOUNT CHECK PASSED — ${passed} assertions`)
}

main().catch((error) => {
  console.error('ACCOUNT CHECK CRASHED:', error && error.stack ? error.stack : error)
  process.exitCode = 1
})
