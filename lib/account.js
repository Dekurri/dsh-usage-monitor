/**
 * dsh-usage-monitor — DeepSeek 账号余额与平台账单探针（Host 侧，契约 §7.2 / §7.4）。
 *
 * 目的：`/ledger` 是「估算」，唯一能和 DeepSeek 开放平台严格对上的消费数字是
 * 「账号钱包余额差」——本模块定期读取 DSH 自带的 `deepseekAccount` 服务，
 * 把余额采样落盘，再用余额差法推算今日 / 昨日 / 近 7 天 / 近 30 天消费。
 *
 * 契约要点（CONTRACT.md §7.2）：
 *   export function createAccountProbe(ctx, options) -> {
 *     refresh(): Promise<void>,
 *     getView(): AccountView,                 // 契约 §7.4，同步读缓存
 *     startSignIn(baseOrigin): Promise<{ authorizeUrl, phase }>,
 *     start(): void,                          // 定时刷新，默认 60s
 *     dispose(): void,                        // 幂等，flush 未落盘数据
 *   }
 *
 * 三个必须记住的坑：
 * 1. **必须用 `ctx.get('deepseekAccount')` 读可选服务，绝不能写进 `inject`**：
 *    老宿主没有该服务，一旦进 inject 整个插件会永远等不到服务而不 apply。
 * 2. 服务真实签名（dsh-deepseek-account 的 .d.ts）：
 *      getState(): Promise<AccountView>
 *      getBalance(clientMeta): Promise<AccountDetails['balance'] | null>
 *      startSignIn(clientMeta, callbackOrigin, 'web' | 'desktop'): Promise<AccountView>
 *    `getState` / `getBalance` / `startSignIn` 全部是 **async**（契约文字里是省略 Promise 的简写）。
 * 3. `getBalance` 返回 `{ status:'ready', value: 充值钱包[], bonusWallets: 赠金钱包[] }`：
 *    **只有赠金钱包（value 为空）也必须算读取成功**（老用户/未充值账号的常见情况），
 *    total = 同币种充值合计 + 同币种赠金合计，币种优先 CNY。
 *
 * 依赖约束：只 import `node:*` 与相对路径（不能 import 任何 @deepseek-ai/* 包）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 缓存文件格式版本。
 * v2：新增自建按天余额账本 `days`（合约 §7.8 的 native 数据源）；加载 v1 文件时
 * 会按已有 `samples` 顺序回放生成 `days`，所以升级不丢「今天已经采样到的消费」。
 */
const CACHE_VERSION = 2
/** 默认刷新间隔（契约 §7.2：默认 60s）。 */
const DEFAULT_REFRESH_INTERVAL_MS = 60_000
/** 采样保留：最近 200 条 + 每天最后一条。 */
const MAX_SAMPLES = 200
/** 硬上限，防止「每天最后一条」随时间无限增长（200 条 × 2 年也够用）。 */
const MAX_SAMPLES_HARD = 400
/** 采样保留窗口：400 天。 */
const RETENTION_MS = 400 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** 账本金额单位：1 CNY = 1e8 units（与小鲸鱼复式记账口径一致，见 CONTRACT §7.8）。 */
const UNITS_PER_CNY = 1e8
/**
 * 自建账本的 `complete` 判据（CONTRACT §7.8）：
 * 观测起点距当日 00:00 不超过 10 分钟才算覆盖零点；对已经过去的日期，
 * 还要求最后一次观测距次日 00:00 不超过 10 分钟。
 */
const LEDGER_EDGE_TOLERANCE_MS = 10 * 60 * 1000
/** 北京时区固定 +08:00（中国无夏令时）；账本按北京时间日历日分账。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
/**
 * 判定「窗口起点是否被采样覆盖」的容差：采样周期 60s，允许比窗口起点晚一个周期内的抖动，
 * 否则每一次完整的「今日」都会被判成不完整。
 */
const COVERAGE_TOLERANCE_MS = 90_000

/** DSH 主目录（与 collect.js / llm-ledger.js 的规则保持一致）。 */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv || join(homedir(), '.dsh')
}

/** 默认落盘路径：$DSH_HOME/usage-monitor/account.json（契约 §7.2）。 */
export function defaultAccountCacheFile() {
  return join(dshHome(), 'usage-monitor', 'account.json')
}

/** 永远返回有限数字；非数字 → 0。 */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 金额保留 6 位小数（与 DSH 账号卡片同精度）。 */
function round6(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Number(n.toFixed(6)) : 0
}

/** 消费金额保留 2 位小数。 */
function round2(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0
}

/** 本地日键（用于「每天最后一条」采样）。 */
function dayKey(at) {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 本地当天 00:00 的时间戳。 */
function startOfLocalDay(at) {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 金额保留 8 位小数（账本单位是 1e-8 CNY）。 */
function round8(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Number(n.toFixed(8)) : 0
}

/** 北京时间日历日键 `YYYY-MM-DD`（账本分账口径，CONTRACT §7.8）。 */
function ledgerDayKey(at) {
  const date = new Date(num(at) + BEIJING_OFFSET_MS)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}-${day}`
}

/** 某个北京日期 00:00（北京时间）对应的 epoch ms；非法键返回 null。 */
function ledgerDayStart(dayKeyText) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKeyText ?? ''))
  if (!match) return null
  const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isFinite(start) ? start - BEIJING_OFFSET_MS : null
}

/** 原子写 JSON：先写 `<file>.tmp` 再 rename。 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value), 'utf8')
  renameSync(tmp, file)
}

/** 读 JSON；失败返回 null。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 错误信息脱敏（只取 message，不输出堆栈/凭据）。 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 请求账号服务时的客户端身份（契约 §7.2 的 clientMeta）。 */
function clientMeta() {
  return {
    version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
    locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/** 空账户视图（契约 §7.4 全字段，`diag` 说明为什么为空）。 */
function emptyView(diag) {
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
    spendCoverage: {
      today: { fromAt: null, complete: false },
      yesterday: { fromAt: null, complete: false },
      last7d: { fromAt: null, complete: false },
      last30d: { fromAt: null, complete: false },
    },
    hasTopUp: false,
    diag: diag || '',
  }
}

/**
 * 归一化采样覆盖信息（契约 §7.4 `spendCoverage`）。
 * `complete:false` 表示该窗口的开头没有采样，金额只是下界；缺失字段按「未知」处理（不崩）。
 */
function normalizeCoverage(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const one = (value) => ({
    fromAt: Number.isFinite(value && value.fromAt) ? value.fromAt : null,
    complete: value && value.complete === true,
  })
  return {
    today: one(source.today),
    yesterday: one(source.yesterday),
    last7d: one(source.last7d),
    last30d: one(source.last30d),
  }
}

/**
 * 归一化窗口完整性（契约 §7.4 `spendComplete`）。
 * `true` 表示该窗口的金额覆盖完整窗口；`false` 表示只是下界（缺采样/缺账本日）。
 */
function normalizeSpendComplete(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    today: source.today === true,
    yesterday: source.yesterday === true,
    last7d: source.last7d === true,
    last30d: source.last30d === true,
  }
}

/** 由采样覆盖信息推导完整性标记（余额采样路径用）。 */
function coverageToComplete(coverage) {
  const source = coverage && typeof coverage === 'object' ? coverage : {}
  return normalizeSpendComplete({
    today: source.today && source.today.complete,
    yesterday: source.yesterday && source.yesterday.complete,
    last7d: source.last7d && source.last7d.complete,
    last30d: source.last30d && source.last30d.complete,
  })
}

/**
 * 归一化 `getBalance()` 的结果：充值钱包 + 赠金钱包，币种优先 CNY。
 * 返回 null 表示「读不到任何钱包」（未登录 / 接口 failed / 没有钱包），
 * 注意「只有赠金」是**成功**，不是 null（见文件头坑 3）。
 *
 * @param {unknown} result
 * @returns {{ total: number, recharge: number, bonus: number, currency: 'CNY' | 'USD' } | null}
 */
function normalizeWallets(result) {
  if (!result || typeof result !== 'object') return null
  if (result.status !== 'ready') return null
  const normalizeRaw = Array.isArray(result.value) ? result.value : []
  const bonusRaw = Array.isArray(result.bonusWallets) ? result.bonusWallets : []
  const usable = (list) => list.filter((wallet) => wallet && typeof wallet === 'object' && Number.isFinite(Number(wallet.balance)))
  const rechargeWallets = usable(normalizeRaw)
  const bonusWallets = usable(bonusRaw)
  const all = rechargeWallets.concat(bonusWallets)
  if (all.length === 0) return null
  const currencyOf = (wallet) => (String(wallet.currency || 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY')
  const nonzero = all.filter((wallet) => Number(wallet.balance) > 0)
  const picked =
    nonzero.find((wallet) => currencyOf(wallet) === 'CNY') ||
    nonzero[0] ||
    all.find((wallet) => currencyOf(wallet) === 'CNY') ||
    all[0]
  const currency = currencyOf(picked)
  const sum = (list) =>
    list.filter((wallet) => currencyOf(wallet) === currency).reduce((total, wallet) => total + num(wallet.balance), 0)
  const recharge = sum(rechargeWallets)
  const bonus = sum(bonusWallets)
  return { total: round6(recharge + bonus), recharge: round6(recharge), bonus: round6(bonus), currency }
}

/**
 * 创建账号余额探针。
 *
 * @param {object} ctx Host context（只需可选 `ctx.get`，按可选处理）
 * @param {object} [options]
 * @param {string} [options.cacheFile] 落盘路径，默认 `$DSH_HOME/usage-monitor/account.json`
 * @param {number} [options.refreshIntervalMs] 刷新间隔，默认 60000
 * @returns {{ refresh: Function, getView: Function, startSignIn: Function, start: Function, dispose: Function, stats: Function }}
 */
export function createAccountProbe(ctx, options) {
  const settings = options && typeof options === 'object' ? options : {}
  const cacheFile =
    typeof settings.cacheFile === 'string' && settings.cacheFile.trim() !== ''
      ? settings.cacheFile
      : defaultAccountCacheFile()
  /** 刷新间隔：兼容 index.js 传入的 `accountRefreshIntervalMs`（cordis.patch.yml 的键名）。 */
  const refreshOption = settings.refreshIntervalMs !== undefined ? settings.refreshIntervalMs : settings.accountRefreshIntervalMs
  const refreshIntervalMs =
    Number.isFinite(Number(refreshOption)) && Number(refreshOption) > 0
      ? Number(refreshOption)
      : DEFAULT_REFRESH_INTERVAL_MS
  /**
   * 可选的历史账单探针（契约 §7.8）：由 index.js 从 `createBillHistory()` 注入，可为 null。
   * 账本可用且新鲜时，它的「当日 debit」比本模块的余额采样更接近平台账单口径。
   */
  const billHistory = settings.billHistory && typeof settings.billHistory === 'object' ? settings.billHistory : null

  /** @type {Array<{at:number,total:number,recharge:number,bonus:number,currency:'CNY'|'USD'}>} */
  let samples = []
  /**
   * 自建按天余额账本（CONTRACT §7.8 native 数据源）：
   * `{ 'YYYY-MM-DD': {day, firstAt, lastAt, openingUnits, lastUnits, debitUnits, creditUnits} }`
   * 金额内部用 1e-8 CNY 的整数单位，避免浮点累计误差。
   */
  let days = Object.create(null)
  let installedAt = Date.now()
  let savedAt = 0
  /** 当前对外的契约视图（getView 同步返回它的副本）。 */
  let view = emptyView('尚未读取账号状态')
  let refreshing = null
  let started = false
  let closed = false
  let timer = null
  /** 最近一次落盘/读取失败原因（人话）。 */
  let saveDiag = ''
  let loadDiag = ''

  /** 可选服务：拿不到返回 null（绝不抛）。 */
  function getService() {
    try {
      if (!ctx || typeof ctx.get !== 'function') return null
      const account = ctx.get('deepseekAccount')
      return account && typeof account === 'object' ? account : null
    } catch {
      return null
    }
  }

  /** 诊断串。 */
  function diagText() {
    const parts = []
    if (!getService()) parts.push('当前 DSH 没有账号服务')
    if (loadDiag) parts.push(loadDiag)
    if (saveDiag) parts.push(saveDiag)
    return parts.join('；')
  }

  /**
   * 历史账单探针的四窗口消费（契约 §7.8）。
   * 只有「可用且新鲜」（账本文件 10 分钟内更新过）才返回，否则 null，调用方退回余额采样。
   * 探针内部已保证绝不抛，这里仍加一层 try/catch 兜底。
   */
  function ledgerSpend(now) {
    if (!billHistory || typeof billHistory.windows !== 'function') return null
    let result = null
    try {
      result = billHistory.windows(now)
    } catch {
      return null
    }
    if (!result || result.available !== true || result.fresh !== true) return null
    if (!result.spend || typeof result.spend !== 'object') return null
    return result
  }

  /** 采样裁剪：最近 200 条 + 每天最后一条（去重、按时间排序、400 天窗口）。 */
  function pruneSamples() {
    if (!samples.length) return
    const now = Date.now()
    samples = samples.filter((sample) => now - sample.at <= RETENTION_MS)
    const dailyLast = new Map()
    for (const sample of samples) dailyLast.set(dayKey(sample.at), sample)
    const recent = samples.slice(-MAX_SAMPLES)
    const merged = []
    const seen = new Set()
    for (const sample of [...dailyLast.values(), ...recent].sort((a, b) => a.at - b.at)) {
      if (seen.has(sample.at)) continue
      seen.add(sample.at)
      merged.push(sample)
    }
    samples = merged.slice(-MAX_SAMPLES_HARD)
  }

  /** 账本按天裁剪（400 天窗口）；空行删除。 */
  function pruneDays() {
    const minAt = Date.now() - RETENTION_MS
    for (const key of Object.keys(days)) {
      const row = days[key]
      if (!row || num(row.lastAt) < minAt) delete days[key]
    }
  }

  /**
   * 用一条余额观测更新自建按天账本（CONTRACT §7.8；语义与小鲸鱼复式记账一致）：
   *   delta = 上一笔余额 - 本次余额；delta > 0 记消费(debitUnits)，delta < 0 记充值(creditUnits)。
   * 新的一天：opening 取之前最近一天的 lastUnits（保证跨零点不漏记消费），
   * 没有更早的观测时 opening = 本次余额。乱序/重复观测（at <= row.lastAt）直接忽略。
   */
  function observeLedger(at, total) {
    const time = num(at)
    if (time <= 0) return
    const units = Math.round(num(total) * UNITS_PER_CNY)
    const key = ledgerDayKey(time)
    const existing = days[key]
    if (existing) {
      if (time <= num(existing.lastAt)) return
      const delta = num(existing.lastUnits) - units
      if (delta > 0) existing.debitUnits = num(existing.debitUnits) + delta
      else if (delta < 0) existing.creditUnits = num(existing.creditUnits) - delta
      existing.lastUnits = units
      existing.lastAt = time
      return
    }
    const previous = previousDayRow(key)
    const openingUnits = previous ? num(previous.lastUnits) : units
    const delta = openingUnits - units
    days[key] = {
      day: key,
      firstAt: time,
      lastAt: time,
      openingUnits,
      lastUnits: units,
      debitUnits: delta > 0 ? delta : 0,
      creditUnits: delta < 0 ? -delta : 0,
    }
  }

  /** 找出 `key` 之前最近的一个账本日行（用于跨零点时继承 opening / 补记消费）。 */
  function previousDayRow(key) {
    let bestKey = null
    for (const candidate of Object.keys(days)) {
      if (candidate < key && (bestKey === null || candidate > bestKey)) bestKey = candidate
    }
    return bestKey === null ? null : days[bestKey]
  }

  /** 从采样历史回放生成账本（v1 迁移 / v2 账本缺失时的兜底）。 */
  function replaySamples() {
    days = Object.create(null)
    for (const sample of samples) observeLedger(sample.at, sample.total)
    pruneDays()
  }

  /** 恢复落盘的按天账本；结构不完整时返回 null（调用方回放 samples）。 */
  function loadDaysFromCache(raw) {
    if (!raw || typeof raw !== 'object') return null
    const rows = Array.isArray(raw) ? raw : Object.values(raw)
    const restored = Object.create(null)
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const key = typeof row.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day) ? row.day : ''
      const lastAt = num(row.lastAt)
      if (!key || lastAt <= 0) continue
      restored[key] = {
        day: key,
        firstAt: num(row.firstAt) || lastAt,
        lastAt,
        openingUnits: num(row.openingUnits),
        lastUnits: num(row.lastUnits),
        debitUnits: num(row.debitUnits),
        creditUnits: num(row.creditUnits),
      }
    }
    return Object.keys(restored).length > 0 ? restored : null
  }

  /** 记录一条余额采样（同一毫秒的重复采样用新值覆盖，避免重复点）。 */
  function pushSample(at, wallet) {
    const sample = {
      at,
      total: wallet.total,
      recharge: wallet.recharge,
      bonus: wallet.bonus,
      currency: wallet.currency,
    }
    const existing = samples.findIndex((row) => row.at === at)
    if (existing >= 0) samples[existing] = sample
    else samples.push(sample)
    samples.sort((a, b) => a.at - b.at)
    pruneSamples()
    // 同一笔观测同时进入自建按天账本（CONTRACT §7.8）；乱序由 observeLedger 内部忽略。
    observeLedger(at, wallet.total)
  }

  /**
   * 余额差法：窗口 [fromAt, toAt] 内 `spend = 首条 total - 末条 total`；
   * 区间内只要出现余额上升就判定「有充值」⇒ value 置 null（契约 §7.2）。
   * 窗口外紧邻的前一条采样作为基线（这样「今天」的第一笔消费也能算出来）。
   *
   * 采样覆盖：`fromAt` 返回真正被这次计算覆盖到的起点（基线与首条窗口内采样的较早者）。
   * 若它晚于窗口起点，说明「窗口开头那段没有采样」，金额只是**下界** ⇒ complete:false。
   * 例：插件今天 00:40 才装上，「今日花费」不可能覆盖 00:00–00:40 的消费。
   */
  function spendFor(fromAt, toAt) {
    if (!samples.length) return { value: null, topUp: false, fromAt: null, complete: false }
    const inWindow = samples.filter((sample) => sample.at >= fromAt && sample.at <= toAt)
    if (inWindow.length === 0) return { value: null, topUp: false, fromAt: null, complete: false }
    const before = samples.filter((sample) => sample.at < fromAt).slice(-1)
    const seq = before.concat(inWindow)
    if (seq.length < 2) return { value: null, topUp: false, fromAt: seq[0] ? seq[0].at : null, complete: false }
    const coveredFrom = seq[0].at
    const complete = coveredFrom <= fromAt + COVERAGE_TOLERANCE_MS
    let topUp = false
    for (let i = 1; i < seq.length; i += 1) {
      if (seq[i].total > seq[i - 1].total + 1e-6) topUp = true
    }
    if (topUp) return { value: null, topUp: true, fromAt: coveredFrom, complete }
    const delta = seq[0].total - seq[seq.length - 1].total
    return { value: round2(Math.max(0, delta)), topUp: false, fromAt: coveredFrom, complete }
  }

  /** 四个窗口的消费 + 汇总 hasTopUp + 每个窗口的采样覆盖信息。 */
  function computeSpend(now) {
    const todayStart = startOfLocalDay(now)
    const yesterdayStart = startOfLocalDay(todayStart - 1)
    const today = spendFor(todayStart, now)
    const yesterday = spendFor(yesterdayStart, todayStart - 1)
    const last7d = spendFor(now - 7 * DAY_MS, now)
    const last30d = spendFor(now - 30 * DAY_MS, now)
    return {
      spend: {
        today: today.value,
        yesterday: yesterday.value,
        last7d: last7d.value,
        last30d: last30d.value,
      },
      coverage: {
        today: { fromAt: today.fromAt, complete: today.complete === true },
        yesterday: { fromAt: yesterday.fromAt, complete: yesterday.complete === true },
        last7d: { fromAt: last7d.fromAt, complete: last7d.complete === true },
        last30d: { fromAt: last30d.fromAt, complete: last30d.complete === true },
      },
      hasTopUp: today.topUp || yesterday.topUp || last7d.topUp || last30d.topUp,
    }
  }

  /** 原子落盘采样；失败只记 diag（绝不抛）。 */
  function save() {
    try {
      pruneSamples()
      pruneDays()
      writeJsonAtomic(cacheFile, {
        version: CACHE_VERSION,
        installedAt,
        savedAt: Date.now(),
        samples,
        days: Object.values(days)
          .slice()
          .sort((a, b) => String(a.day).localeCompare(String(b.day))),
      })
      savedAt = Date.now()
      saveDiag = ''
    } catch (error) {
      saveDiag = `账号采样落盘失败: ${errorMessage(error)}`.slice(0, 200)
    }
  }

  /** 读取落盘采样与自建账本；失败只记 diag。 */
  function load() {
    const data = readJson(cacheFile)
    if (data === null) return
    if (!data || typeof data !== 'object' || (data.version !== 1 && data.version !== 2)) {
      loadDiag = '账号采样缓存版本不匹配，已忽略旧文件'
      return
    }
    installedAt = num(data.installedAt) || installedAt
    savedAt = num(data.savedAt)
    const list = Array.isArray(data.samples) ? data.samples : []
    const loaded = []
    for (const row of list) {
      if (!row || typeof row !== 'object') continue
      const at = num(row.at)
      if (at <= 0) continue
      loaded.push({
        at,
        total: num(row.total),
        recharge: num(row.recharge),
        bonus: num(row.bonus),
        currency: String(row.currency || 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY',
      })
    }
    loaded.sort((a, b) => a.at - b.at)
    samples = loaded
    pruneSamples()
    const restored = data.version === 2 ? loadDaysFromCache(data.days) : null
    if (restored) {
      days = restored
      pruneDays()
    } else {
      // v1 → v2 迁移（或 v2 的 days 缺失/损坏）：按已有采样顺序回放，生成按天账本。
      replaySamples()
      if (data.version === 1) loadDiag = loadDiag || '账号缓存已从 v1 迁移：按已有采样回放生成按天账本'
    }
  }

  /** 真正执行一次刷新（失败只写 diag 视图，不抛）。 */
  async function doRefresh() {
    const now = Date.now()
    const account = getService()
    if (!account) {
      view = emptyView(diagText() || '当前 DSH 没有账号服务')
      return
    }
    let state = null
    try {
      if (typeof account.getState === 'function') state = await account.getState()
    } catch (error) {
      view = emptyView(`账号状态读取失败: ${errorMessage(error)}`.slice(0, 200))
      return
    }
    const links = state && state.links && typeof state.links === 'object' ? state.links : {}
    const usageUrl = typeof links.usageUrl === 'string' ? links.usageUrl : ''
    const topUpUrl = typeof links.topUpUrl === 'string' ? links.topUpUrl : ''
    const signedIn = Boolean(state && state.status === 'credential-stored')
    if (!signedIn) {
      const attempt = state && state.attempt ? state.attempt : null
      const attemptDiag = attempt && attempt.errorCode ? `上次登录失败: ${attempt.errorCode}` : ''
      view = {
        ...emptyView(diagText()),
        available: true,
        signedIn: false,
        usageUrl,
        topUpUrl,
        diag: attemptDiag,
      }
      return
    }
    let balance = null
    let balanceDiag = ''
    try {
      if (typeof account.getBalance === 'function') balance = await account.getBalance(clientMeta())
    } catch (error) {
      balanceDiag = `账号余额读取失败: ${errorMessage(error)}`.slice(0, 200)
    }
    const wallet = normalizeWallets(balance)
    if (!wallet) {
      view = {
        ...emptyView(balanceDiag || '账号余额不可用（接口未就绪或没有钱包）'),
        available: true,
        signedIn: true,
        usageUrl,
        topUpUrl,
      }
      return
    }
    pushSample(now, wallet)
    const spendInfo = computeSpend(now)
    // 历史账单优先：账本可用且新鲜时，用账本的「当日 debit」替代余额采样（契约 §7.4 / §7.8）。
    const ledger = ledgerSpend(now)
    let spend = spendInfo.spend
    let spendCoverage = spendInfo.coverage
    let spendComplete = coverageToComplete(spendInfo.coverage)
    let spendSource = 'balance-sampling'
    let hasTopUp = spendInfo.hasTopUp
    let accountDiag = balanceDiag
    if (ledger) {
      spendSource = 'wallet-ledger'
      spend = {
        today: round2(num(ledger.spend.today)),
        yesterday: round2(num(ledger.spend.yesterday)),
        last7d: round2(num(ledger.spend.last7d)),
        last30d: round2(num(ledger.spend.last30d)),
      }
      spendComplete = normalizeSpendComplete(ledger.complete)
      spendCoverage = normalizeCoverage(ledger.coverage)
      const credit = ledger.credit && typeof ledger.credit === 'object' ? ledger.credit : {}
      hasTopUp =
        hasTopUp ||
        num(credit.today) > 1e-6 ||
        num(credit.yesterday) > 1e-6 ||
        num(credit.last7d) > 1e-6 ||
        num(credit.last30d) > 1e-6
    } else if (billHistory) {
      // 账本存在但不可用/过期：保留余额采样结果，并把原因写进 diag（人话）。
      accountDiag = `${balanceDiag ? `${balanceDiag}；` : ''}余额账本超过 10 分钟未更新，已退回本插件余额采样`
    }
    view = {
      generatedAt: Date.now(),
      available: true,
      signedIn: true,
      currency: wallet.currency,
      balance: { total: wallet.total, recharge: wallet.recharge, bonus: wallet.bonus },
      sampledAt: now,
      usageUrl,
      topUpUrl,
      spend,
      spendSource,
      spendComplete,
      spendCoverage,
      hasTopUp,
      diag: accountDiag,
    }
    save()
  }

  /** 只读契约视图（同步、无 IO、绝不抛）。 */
  function getView() {
    try {
      return {
        generatedAt: Date.now(),
        available: view.available === true,
        signedIn: view.signedIn === true,
        currency: view.currency === 'USD' ? 'USD' : 'CNY',
        balance: {
          total: num(view.balance && view.balance.total),
          recharge: num(view.balance && view.balance.recharge),
          bonus: num(view.balance && view.balance.bonus),
        },
        sampledAt: num(view.sampledAt),
        usageUrl: typeof view.usageUrl === 'string' ? view.usageUrl : '',
        topUpUrl: typeof view.topUpUrl === 'string' ? view.topUpUrl : '',
        spend: {
          today: Number.isFinite(view.spend && view.spend.today) ? view.spend.today : null,
          yesterday: Number.isFinite(view.spend && view.spend.yesterday) ? view.spend.yesterday : null,
          last7d: Number.isFinite(view.spend && view.spend.last7d) ? view.spend.last7d : null,
          last30d: Number.isFinite(view.spend && view.spend.last30d) ? view.spend.last30d : null,
        },
        spendCoverage: normalizeCoverage(view.spendCoverage),
        spendSource: view.spendSource === 'wallet-ledger' ? 'wallet-ledger' : 'balance-sampling',
        spendComplete: normalizeSpendComplete(view.spendComplete),
        hasTopUp: view.hasTopUp === true,
        diag: typeof view.diag === 'string' ? view.diag : '',
      }
    } catch (error) {
      return emptyView(`账号视图构建失败: ${errorMessage(error)}`.slice(0, 200))
    }
  }

  /**
   * 自建按天余额账本（CONTRACT §7.8 的 native 数据源）。
   * 同步、无 IO、绝不抛；没有观测时返回空 `days`（由 bill-history 决定是否用 whale 回填）。
   *
   * @returns {{source:'usage-monitor', currency:'CNY'|'USD', scopeTag:string, days:Array}}
   */
  function dailyLedger() {
    try {
      const todayKey = ledgerDayKey(Date.now())
      const rows = Object.values(days)
        .filter((row) => row && typeof row.day === 'string')
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
        .map((row) => {
          const midnight = ledgerDayStart(row.day)
          const nextMidnight = midnight === null ? null : midnight + DAY_MS
          // 起点靠近 00:00 才算覆盖了当天的开头；已过去的日期还要求观测延续到接近次日 00:00。
          const startCovered = midnight !== null && num(row.firstAt) <= midnight + LEDGER_EDGE_TOLERANCE_MS
          const endCovered =
            nextMidnight === null || row.day >= todayKey || num(row.lastAt) >= nextMidnight - LEDGER_EDGE_TOLERANCE_MS
          const debit = round8(num(row.debitUnits) / UNITS_PER_CNY)
          return {
            day: row.day,
            cost: debit,
            debit,
            credit: round8(num(row.creditUnits) / UNITS_PER_CNY),
            opening: round8(num(row.openingUnits) / UNITS_PER_CNY),
            closing: round8(num(row.lastUnits) / UNITS_PER_CNY),
            firstAt: num(row.firstAt),
            lastAt: num(row.lastAt),
            complete: startCovered && endCovered,
          }
        })
      return {
        source: 'usage-monitor',
        currency: view && view.currency === 'USD' ? 'USD' : 'CNY',
        scopeTag: 'account',
        days: rows,
      }
    } catch (error) {
      return { source: 'usage-monitor', currency: 'CNY', scopeTag: 'account', days: [], diag: errorMessage(error) }
    }
  }

  /** 立即刷新一次（并发合并；失败写 diag 视图，不 reject）。 */
  function refresh() {
    if (closed) return Promise.resolve()
    if (refreshing) return refreshing
    refreshing = doRefresh()
      .catch((error) => {
        view = emptyView(`账号刷新失败: ${errorMessage(error)}`.slice(0, 200))
      })
      .finally(() => {
        refreshing = null
      })
    return refreshing
  }

  return {
    refresh,

    /** 同步读缓存的契约 §7.4 视图。 */
    getView,

    /** 自建按天余额账本（自带持久化；供 /bill-history 合并，契约 §7.8）。 */
    dailyLedger,

    /** 发起网页登录：返回授权地址；调用方 `window.open` 打开后轮询 /account。 */
    async startSignIn(baseOrigin) {
      const account = getService()
      if (!account || typeof account.startSignIn !== 'function') {
        const error = new Error('当前 DSH 没有账号服务，无法发起登录')
        error.diag = '当前 DSH 没有账号服务'
        throw error
      }
      const origin = typeof baseOrigin === 'string' && baseOrigin.trim() !== '' ? baseOrigin.trim() : 'http://127.0.0.1'
      const state = await account.startSignIn(clientMeta(), origin, 'web')
      const attempt = state && state.attempt && typeof state.attempt === 'object' ? state.attempt : null
      const authorizeUrl = attempt && typeof attempt.authorizeUrl === 'string' ? attempt.authorizeUrl : ''
      if (!authorizeUrl) {
        const phase = attempt && typeof attempt.phase === 'string' ? attempt.phase : 'unknown'
        const error = new Error(`登录授权地址未返回（阶段: ${phase}）`)
        error.diag = '登录未拿到 authorizeUrl'
        throw error
      }
      refresh().catch(() => {})
      return { authorizeUrl, phase: typeof attempt.phase === 'string' ? attempt.phase : 'waiting-browser' }
    },

    /** 启动：读缓存 + 立即刷新一次 + 定时刷新（幂等、不抛）。 */
    start() {
      if (started || closed) return
      started = true
      try {
        load()
      } catch (error) {
        loadDiag = `账号采样缓存读取失败: ${errorMessage(error)}`.slice(0, 200)
      }
      refresh().catch(() => {})
      try {
        timer = setInterval(() => {
          refresh().catch(() => {})
        }, refreshIntervalMs)
        if (timer && typeof timer.unref === 'function') timer.unref()
      } catch {
        // 定时器不可用时仍可手动 refresh。
      }
    },

    /** 停止并落盘；幂等。 */
    dispose() {
      if (closed) return
      closed = true
      if (timer) {
        try {
          clearInterval(timer)
        } catch {
          // 忽略
        }
        timer = null
      }
      save()
    },

    /** 诊断信息（测试/排障用，不属于契约）。 */
    stats() {
      return {
        started,
        closed,
        installedAt,
        savedAt,
        samples: samples.length,
        days: Object.keys(days).length,
        cacheFile,
        diag: diagText(),
      }
    },
  }
}
