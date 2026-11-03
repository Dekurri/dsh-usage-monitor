/**
 * dsh-usage-monitor — HTTP 路由注册（Host 侧）。
 *
 * 契约（CONTRACT.md §2 / §3）：
 *   export function registerUsageRoutes(ctx, collector, disposers) -> void
 *
 * - 前缀常量 `BASE = '/usage-monitor/api'`。
 * - 两个 GET 路由：`${BASE}/overview`、`${BASE}/live`。
 * - 统一返回 `Content-Type: application/json; charset=utf-8` + `Cache-Control: no-store`；
 *   错误 → `500 { error: string }`。
 * - 每个路由用 `ctx.webServer.register({ kind: 'exact', path, handler })` 注册，
 *   返回的 disposer 推进 index.js 传入的 `disposers` 数组（插件卸载时统一调用）。
 * - 路由 handler 完全拥有响应生命周期：必须自己解析 query（`new URL(req.url, 'http://localhost')`），
 *   必须 try/catch 兜 500，绝不让异常冒到 Host。
 */

/** 路由前缀（契约 §2；与 Client 侧常量必须一致）。 */
export const BASE = '/usage-monitor/api'

/**
 * 发送 JSON 响应。响应已被写过时静默返回（避免 ERR_STREAM_WRITE_AFTER_END）。
 * @param {object} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  if (!res || typeof res !== 'object') return
  if (res.writableEnded === true || res.headersSent === true) return
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    body = '{"error":"failed to serialize response"}'
    status = 500
  }
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
  } catch {
    // 某些环境下 writeHead 失败时仍然可以 end；继续尝试。
  }
  try {
    res.end(body)
  } catch {
    try {
      if (typeof res.destroy === 'function') res.destroy()
    } catch {
      // 忽略
    }
  }
}

/** 只接受 GET（契约 §2：均为 GET）。 */
function isGet(req) {
  return !req || req.method === undefined || req.method === 'GET'
}

/** 错误信息脱敏成字符串。 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 本地时区当天 00:00 的 epoch ms（today range 的起点）。 */
function startOfLocalDay(time) {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** ledger 时间范围（与 llm-ledger.js 的 RANGE_DEFS 保持一致；fallback 视图用）。 */
const LEDGER_RANGE_DEFS = {
  today: { ms: null, label: '今日（本地 00:00 起）' },
  '24h': { ms: 24 * 3600e3, label: '近 24 小时' },
  '7d': { ms: 7 * 24 * 3600e3, label: '近 7 天' },
  '14d': { ms: 14 * 24 * 3600e3, label: '近 14 天' },
  '30d': { ms: 30 * 24 * 3600e3, label: '近 30 天' },
  all: { ms: null, label: '全部（自安装起）' },
}

/** range 键归一（未知值回落 24h，与 collect.js / llm-ledger.js 一致）。 */
function ledgerRangeKey(value) {
  const key = typeof value === 'string' ? value : ''
  return Object.prototype.hasOwnProperty.call(LEDGER_RANGE_DEFS, key) ? key : '24h'
}

/** 构造 ledger fallback 视图的 range 段。 */
function ledgerRange(key, installedAt) {
  const def = LEDGER_RANGE_DEFS[key]
  const to = Date.now()
  const from =
    key === 'today'
      ? startOfLocalDay(to)
      : def.ms === null
        ? Number.isFinite(installedAt)
          ? installedAt
          : 0
        : Math.max(0, to - def.ms)
  return { key, from, to, label: def.label }
}

/**
 * 账本不可用时的合法 fallback（契约 §7.3 全字段，绝不 500）。
 * @param {string} rangeKey
 * @param {string} diag
 */
function emptyLedgerView(rangeKey, diag) {
  const key = ledgerRangeKey(rangeKey)
  return {
    generatedAt: Date.now(),
    available: false,
    installedAt: 0,
    range: ledgerRange(key, 0),
    currency: 'CNY',
    fxRate: 7.1,
    fx: { baseCurrency: 'CNY', usdCnyRate: 7.1 },
    totals: {
      requests: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
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
    diag: diag || '',
  }
}

/**
 * 账号探针不可用时的合法 fallback（契约 §7.4 全字段，绝不 500）。
 * @param {string} diag
 */
function emptyAccountView(diag) {
  return {
    generatedAt: Date.now(),
    available: false,
    signedIn: false,
    currency: 'CNY',
    balance: { total: 0, recharge: 0, bonus: 0 },
    sampledAt: 0,
    usageUrl: '',
    topUpUrl: '',
    spend: { today: null, yesterday: null, last7d: null, last30d: null },
    spendSource: 'balance-sampling',
    spendComplete: { today: false, yesterday: false, last7d: false, last30d: false },
    hasTopUp: false,
    diag: diag || '',
  }
}

/** 历史账单（wallet-ledger）范围定义（契约 §7.8；fallback 视图用）。 */
const BILL_HISTORY_RANGE_DEFS = {
  '7d': { label: '近 7 天' },
  '14d': { label: '近 14 天' },
  '30d': { label: '近 30 天' },
  all: { label: '全部账本天数' },
}

/** bill-history range 归一（未知值回落 30d）。 */
function billHistoryRangeKey(value) {
  const key = typeof value === 'string' ? value : ''
  return Object.prototype.hasOwnProperty.call(BILL_HISTORY_RANGE_DEFS, key) ? key : '30d'
}

/**
 * 历史账单不可用时的合法 fallback（契约 §7.8 全字段，绝不 500）。
 * @param {string} rangeKey
 * @param {string} diag
 */
function emptyBillHistoryView(rangeKey, diag) {
  const key = billHistoryRangeKey(rangeKey)
  return {
    generatedAt: Date.now(),
    available: false,
    source: 'whale',
    legacySource: 'wallet-ledger',
    currency: 'CNY',
    range: { key, label: BILL_HISTORY_RANGE_DEFS[key].label },
    days: [],
    since: null,
    until: null,
    totals: { '7d': { cost: 0 }, '14d': { cost: 0 }, '30d': { cost: 0 }, all: { cost: 0 } },
    freshness: { fileMtime: 0, ageMs: 0, nativeDays: 0, whaleDays: 0 },
    diag: diag || '',
  }
}

/** 从请求里取 `X-Forwarded-Host`/`Host` 组成同源回调 origin（契约 §7.5）。 */
function requestOrigin(req) {
  try {
    const headers = req && typeof req === 'object' && req.headers ? req.headers : {}
    const forwarded = typeof headers['x-forwarded-host'] === 'string' ? headers['x-forwarded-host'] : ''
    const host = forwarded || (typeof headers.host === 'string' ? headers.host : '') || '127.0.0.1'
    const pathname = typeof req.url === 'string' && req.url !== '' ? req.url : '/'
    return new URL(pathname, `http://${host}`).origin
  } catch {
    return 'http://127.0.0.1'
  }
}

/**
 * 注册 usage-monitor 的 HTTP 路由（契约 §2 / §7.3–§7.5）。
 * @param {object} ctx Host context（需要 ctx.webServer）
 * @param {ReturnType<import('./collect.js').createCollector>} collector
 * @param {Array<() => void>} [disposers] index.js 传入的清理函数数组
 * @param {{ ledger?: object|null, account?: object|null, billHistory?: object|null, fxRate?: object|null }|null} [extras]
 *        v2/v3 可选模块；可以是 null / 字段为 null（模块启动失败），此时返回合法 fallback 视图。
 */
export function registerUsageRoutes(ctx, collector, disposers, extras) {
  const list = Array.isArray(disposers) ? disposers : []
  const modules = extras && typeof extras === 'object' ? extras : {}
  const ledger = modules.ledger && typeof modules.ledger === 'object' ? modules.ledger : null
  const account = modules.account && typeof modules.account === 'object' ? modules.account : null
  const billHistory = modules.billHistory && typeof modules.billHistory === 'object' ? modules.billHistory : null
  const fxRate = modules.fxRate && typeof modules.fxRate === 'object' ? modules.fxRate : null
  const webServer = ctx && typeof ctx === 'object' ? ctx.webServer : null
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('ctx.webServer.register is unavailable')
  }

  /** 注册一个 exact 路由，并把 disposer 收进 list。 */
  function register(path, handler) {
    const off = webServer.register({ kind: 'exact', path, handler })
    if (typeof off === 'function') list.push(off)
    return off
  }

  /** 解析 query（不合法时回落到安全默认）。 */
  function queryOf(req) {
    try {
      return new URL(typeof req.url === 'string' ? req.url : '/', 'http://localhost').searchParams
    } catch {
      return new URLSearchParams()
    }
  }

  /** GET /usage-monitor/api/overview?range=…&currency=… */
  async function handleOverview(req, res) {
    if (!isGet(req)) {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      const params = queryOf(req)
      const range = params.get('range') ?? '24h'
      // 币种默认 CNY（人民币是权威基准；非法值也落 CNY）。
      const currency = (params.get('currency') ?? 'CNY').toUpperCase()
      const overview = await collector.getOverview({ range, currency })
      sendJson(res, 200, overview)
    } catch (error) {
      sendJson(res, 500, { error: errorMessage(error) })
    }
  }

  /** GET /usage-monitor/api/live */
  function handleLive(req, res) {
    if (!isGet(req)) {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      const live = collector.getLive()
      sendJson(res, 200, live)
    } catch (error) {
      sendJson(res, 500, { error: errorMessage(error) })
    }
  }

  /** GET /usage-monitor/api/ledger?range=…（契约 §7.3） */
  function handleLedger(req, res) {
    if (!isGet(req)) {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      const params = queryOf(req)
      const range = params.get('range') ?? '24h'
      const currency = (params.get('currency') ?? 'CNY').toUpperCase()
      if (!ledger || typeof ledger.snapshot !== 'function') {
        // 模块未启动/构造失败：返回合法空视图 + available:false，绝不 500（契约 §7.3）。
        sendJson(res, 200, emptyLedgerView(range, '调用账本模块未启动（Host 装配时创建失败）'))
        return
      }
      sendJson(res, 200, ledger.snapshot({ range, currency }))
    } catch (error) {
      sendJson(res, 200, emptyLedgerView('24h', `账本视图读取失败: ${errorMessage(error)}`.slice(0, 200)))
    }
  }

  /** 汇率服务的降级视图（模块缺失/异常）：契约 §7.9，绝不 500。 */
  function emptyFxView(diag) {
    return {
      generatedAt: Date.now(),
      available: false,
      rate: 7.1,
      currency: 'CNY',
      quote: 'USD',
      source: 'config',
      sourceLabel: '配置兜底值（离线/获取失败）',
      effectiveDate: null,
      fetchedAt: 0,
      stale: true,
      diag,
    }
  }

  /** GET /usage-monitor/api/fx（契约 §7.9：实时央行中间价视图，绝不 500） */
  function handleFx(req, res) {
    if (!isGet(req)) {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      if (!fxRate || typeof fxRate.getRate !== 'function') {
        sendJson(res, 200, emptyFxView('汇率服务不可用（Host 装配时创建失败）'))
        return
      }
      const view = fxRate.getRate()
      if (!view || typeof view !== 'object' || !(Number(view.rate) > 0)) {
        sendJson(res, 200, emptyFxView('汇率服务尚未返回有效值'))
        return
      }
      sendJson(res, 200, { generatedAt: Date.now(), available: true, ...view })
    } catch (error) {
      sendJson(res, 200, emptyFxView(`汇率视图读取失败: ${errorMessage(error)}`.slice(0, 200)))
    }
  }

  /** GET /usage-monitor/api/bill-history?range=7d|14d|30d|all（契约 §7.8） */
  function handleBillHistory(req, res) {
    if (!isGet(req)) {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const params = queryOf(req)
    const range = billHistoryRangeKey(params.get('range'))
    if (!billHistory || typeof billHistory.snapshot !== 'function') {
      // 模块未启动/构造失败：返回合法空视图 + available:false，绝不 500（契约 §7.8）。
      sendJson(res, 200, emptyBillHistoryView(range, '历史账单模块未启动（Host 装配时创建失败）'))
      return
    }
    try {
      const view = billHistory.snapshot({ range })
      sendJson(res, 200, view && typeof view === 'object' ? view : emptyBillHistoryView(range, '历史账单视图为空'))
    } catch (error) {
      sendJson(res, 200, emptyBillHistoryView(range, `历史账单读取失败: ${errorMessage(error)}`.slice(0, 200)))
    }
  }

  /** GET /usage-monitor/api/account（契约 §7.4） */
  function handleAccount(req, res) {
    if (!isGet(req)) {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    try {
      if (!account || typeof account.getView !== 'function') {
        sendJson(res, 200, emptyAccountView('账号模块未启动（Host 装配时创建失败）'))
        return
      }
      sendJson(res, 200, account.getView())
    } catch (error) {
      sendJson(res, 200, emptyAccountView(`账号视图读取失败: ${errorMessage(error)}`.slice(0, 200)))
    }
  }

  /** POST /usage-monitor/api/account/login（契约 §7.5） */
  async function handleLogin(req, res) {
    if (!req || req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (!account || typeof account.startSignIn !== 'function') {
      sendJson(res, 500, { error: '账号模块未启动', diag: '账号模块未启动（Host 装配时创建失败）' })
      return
    }
    try {
      const result = await account.startSignIn(requestOrigin(req))
      const authorizeUrl = result && typeof result.authorizeUrl === 'string' ? result.authorizeUrl : ''
      if (authorizeUrl === '') throw new Error('授权地址为空')
      sendJson(res, 200, {
        authorizeUrl,
        phase: result && typeof result.phase === 'string' ? result.phase : 'waiting-browser',
      })
    } catch (error) {
      const diag = error && typeof error.diag === 'string' ? error.diag : '登录发起失败'
      sendJson(res, 500, { error: errorMessage(error), diag })
    }
  }

  register(`${BASE}/overview`, handleOverview)
  register(`${BASE}/live`, handleLive)
  register(`${BASE}/ledger`, handleLedger)
  register(`${BASE}/account`, handleAccount)
  register(`${BASE}/account/login`, handleLogin)
  register(`${BASE}/bill-history`, handleBillHistory)
  register(`${BASE}/fx`, handleFx)
}
