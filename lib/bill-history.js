/**
 * 历史账单 / 余额账本（契约 §7.8）——跨「插件安装起」限制的数据源。
 *
 * 从 v6 起有**两个来源**，本模块只做合并与视图：
 *   1. `native`（主源，函数）：`lib/account.js` 用 `deepseekAccount.getBalance()`
 *      自建的按天余额账本（`dailyLedger()`），持久化在 `account.json` 里，
 *      覆盖本插件安装之后的所有采样；不再依赖任何其它插件。
 *   2. whale 回填（可选历史）：本机 dsh-whale-widget 留下的 `$DSH_HOME/.dshw-usage.json`
 *      （按天复式记账，1 CNY = 1e8 units），用来补本插件安装之前的更早日期。
 *
 * 合并规则（v6.1，契约 §7.8）：
 *   - 单来源日期直接透传（native 天 `origin:'monitor'`、whale 天 `origin:'whale'`）；
 *   - 双来源都有的日期做**观测级合并**：把两行各自的 `{firstAt,opening}`、`{lastAt,closing}`
 *     还原成观测点，按 at 升序（同一时刻优先 native）去重后，用与 `lib/account.js`
 *     相同的回放算法重新累计 debit/credit ⇒ `opening` 取最早窗口、`closing` 取最新窗口、
 *     debit 覆盖中间全部净下降，`origin:'monitor+whale'`。
 *     （整行二选一会丢掉「更早起点」或「更晚终点」的一半数据。）
 *   `source` 取值 `'monitor' | 'whale' | 'monitor+whale'`，同时保留 `legacySource:'wallet-ledger'`
 *   兼容旧客户端。
 *
 * 设计原则：
 *   - whale 文件**只读**，绝不写、绝不删、绝不改；格式变化/缺失只降级为 diag，**绝不抛**；
 *   - 构造期不做 IO（`createBillHistory()` 只建状态），`load()` 才读；
 *   - whale 文件解析结果缓存到 `$DSH_HOME/usage-monitor/bill-history.json`，用源文件
 *     mtime + size 判断是否需要重读（避免每 30s 重解析 28KB JSON）。
 *
 * 导出：
 *   export function defaultBillHistoryFile() -> string
 *   export function defaultBillHistoryCacheFile() -> string
 *   export function createBillHistory(options) -> {
 *     load(): BillHistoryState,
 *     snapshot(options?): BillHistoryView,
 *     windows(now?): LedgerWindows,
 *     dispose(): void,
 *     stats(): object,
 *   }
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 缓存结构版本；源文件格式变化时提升。 */
const CACHE_VERSION = 1

/** 1 CNY = 1e8 账本单位（已用真实数据校准，见文件头）。 */
const UNITS_PER_CNY = 1e8

/** `complete` 判定容差：当天记账起点不晚于本地 00:00 之后 90s 才算覆盖零点。 */
const COVERAGE_TOLERANCE_MS = 90_000

/** 账本超过 10 分钟没更新即视为过期（此时 /account 退回自采样，见契约 §7.4 / §7.8）。 */
const FRESH_TOLERANCE_MS = 10 * 60 * 1000

/** native 天的 `complete` 判据容差（与 lib/account.js 的 `LEDGER_EDGE_TOLERANCE_MS` 保持一致）。 */
const NATIVE_EDGE_TOLERANCE_MS = 10 * 60 * 1000

/** 金额保留 6 位小数（账本单位是 1e-8 CNY，展示到 1e-6 足够）。 */
const round6 = (value) => (Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : 0)

/** 时间范围定义：天窗口大小；`all` = 全部（不裁剪）。 */
const RANGE_DAYS = Object.freeze({ '7d': 7, '14d': 14, '30d': 30, all: null })

/** 时间范围展示名（契约 §7.8 的 `range.label`）。 */
const RANGE_LABELS = Object.freeze({ '7d': '近 7 天', '14d': '近 14 天', '30d': '近 30 天', all: '全部账本天数' })

/** `$DSH_HOME`：与其它模块保持同一约定。 */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** 源账本默认路径：`$DSH_HOME/.dshw-usage.json`（另一个插件的文件，只读）。 */
export function defaultBillHistoryFile() {
  return join(dshHome(), '.dshw-usage.json')
}

/** 解析结果缓存默认路径：`$DSH_HOME/usage-monitor/bill-history.json`。 */
export function defaultBillHistoryCacheFile() {
  return join(dshHome(), 'usage-monitor', 'bill-history.json')
}

function num(value) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 本地日期键 `YYYY-MM-DD`。 */
function dayKeyOf(timeMs) {
  const date = new Date(timeMs)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 某个 `YYYY-MM-DD` 本地零点的 epoch ms。 */
function startOfLocalDayKey(dayKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey ?? ''))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
}

/** 读 JSON；不存在/损坏返回 null（绝不抛）。 */
function readJson(file) {
  try {
    const text = readFileSync(file, 'utf8')
    if (typeof text !== 'string' || text.trim() === '') return null
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 原子写 JSON（先写 .tmp 再 rename）；失败静默。 */
function writeJsonAtomic(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value), 'utf8')
    renameSync(tmp, file)
  } catch {
    // 缓存写失败不影响对外视图。
  }
}

/**
 * 把一天账本记录归一化成契约 §7.8 的日行。
 *
 * @param {string} key 日期键（`YYYY-MM-DD`）
 * @param {object} raw 源账本里的 day 对象
 * @returns {{day:string,cost:number,debit:number,credit:number,opening:number,closing:number,firstAt:number,lastAt:number,complete:boolean}}
 */
function normalizeDay(key, raw) {
  const row = raw && typeof raw === 'object' ? raw : {}
  const day = typeof row.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day) ? row.day : key
  const debit = round6(num(row.debitUnits) / UNITS_PER_CNY)
  const credit = round6(num(row.creditUnits) / UNITS_PER_CNY)
  const opening = round6(num(row.openingUnits) / UNITS_PER_CNY)
  const closing = round6(num(row.lastUnits) / UNITS_PER_CNY)
  const firstAt = num(row.firstAt)
  const lastAt = num(row.lastAt)
  const midnight = startOfLocalDayKey(day)
  // complete：当天记账从本地零点（+90s 容差）开始，说明这一天的 debit 覆盖完整一天；
  // 10-24 这类只覆盖半天的数据必须标 false，UI 会显示为「≥」/虚线。
  const complete = midnight !== null && firstAt > 0 && firstAt <= midnight + COVERAGE_TOLERANCE_MS
  return { day, cost: debit, debit, credit, opening, closing, firstAt, lastAt, complete }
}

/**
 * 解析源账本 JSON，返回 `{ available, source, currency, days, since, until, diag }`。
 * @param {unknown} root
 * @param {string} [nowDiag] 额外 diag 前缀
 */
function parseBillHistory(root, nowDiag) {
  const empty = (diag) => ({
    available: false,
    source: 'wallet-ledger',
    currency: 'CNY',
    days: [],
    since: null,
    until: null,
    diag: diag || '',
  })
  if (!root || typeof root !== 'object') return empty(nowDiag || '余额账本内容无法解析')

  const accounting = root.accounting && typeof root.accounting === 'object' ? root.accounting : null
  let days = []
  let diag = nowDiag || ''

  if (accounting) {
    if (accounting.version !== 1) {
      return empty(`余额账本格式版本不支持（version=${String(accounting.version)}），已忽略`)
    }
    const books = accounting.books && typeof accounting.books === 'object' ? accounting.books : null
    if (!books) return empty('余额账本缺少 accounting.books 区块')
    const bookKeys = Object.keys(books)
    if (bookKeys.length === 0) return empty('余额账本没有任何币种账本')
    // 优先 CNY 账本；否则取第一个（契约 §7.8）。
    let bookKey = bookKeys.find((key) => {
      const book = books[key]
      return book && typeof book === 'object' && String(book.currency || '').toUpperCase() === 'CNY'
    })
    if (!bookKey) bookKey = bookKeys[0]
    const book = books[bookKey] && typeof books[bookKey] === 'object' ? books[bookKey] : null
    if (!book) return empty('余额账本选中的币种账本不可读')
    const dayMap = book.days && typeof book.days === 'object' ? book.days : null
    if (!dayMap) return empty(`余额账本币种账本 ${bookKey} 缺少 days 区块`)
    days = Object.keys(dayMap)
      .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))
      .sort()
      .map((key) => normalizeDay(key, dayMap[key]))
    const currency = String(book.currency || 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY'
    if (currency !== 'CNY') diag = diag || `余额账本选中的是 ${currency} 账本`
  } else if (root.history && typeof root.history === 'object') {
    // 兼容兜底：没有 accounting 但有 history（日金额，单位已是 CNY）。
    days = Object.keys(root.history)
      .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))
      .sort()
      .map((key) => {
        const cost = round6(num(root.history[key]))
        return {
          day: key,
          cost,
          debit: cost,
          credit: 0,
          opening: 0,
          closing: 0,
          firstAt: 0,
          lastAt: 0,
          complete: false,
        }
      })
    diag = diag || '余额账本缺少 accounting 区块，已降级使用 history 日金额（complete 一律为 false）'
  } else {
    return empty(nowDiag || '余额账本既没有 accounting 也没有 history 区块')
  }

  if (days.length === 0) return empty(diag || '余额账本没有可用的按天记录')
  return {
    available: true,
    source: 'wallet-ledger',
    currency: 'CNY',
    days,
    since: days[0].day,
    until: days[days.length - 1].day,
    diag,
  }
}

/**
 * 创建历史账单探针。
 *
 * @param {object} [options]
 * @param {string} [options.file] 源账本路径，默认 `$DSH_HOME/.dshw-usage.json`
 * @param {string} [options.cacheFile] 解析缓存路径，默认 `$DSH_HOME/usage-monitor/bill-history.json`
 */
export function createBillHistory(options) {
  const settings = options && typeof options === 'object' ? options : {}
  const file =
    typeof settings.file === 'string' && settings.file.trim() !== '' ? settings.file : defaultBillHistoryFile()
  const cacheFile =
    typeof settings.cacheFile === 'string' && settings.cacheFile.trim() !== ''
      ? settings.cacheFile
      : defaultBillHistoryCacheFile()
  /**
   * 主源：本插件自建的按天余额账本（`lib/account.js` 的 `dailyLedger()`）。
   * 函数可能返回 null / 空 days（刚启动、未登录、服务缺失），此时只用 whale 回填。
   */
  const nativeSource = typeof settings.native === 'function' ? settings.native : null

  /** 读取 native 账本并归一化；没有数据返回 null（绝不抛）。 */
  function readNative() {
    if (!nativeSource) return null
    let ledger = null
    try {
      ledger = nativeSource()
    } catch {
      return null
    }
    if (!ledger || typeof ledger !== 'object' || !Array.isArray(ledger.days)) return null
    const rows = []
    for (const row of ledger.days) {
      if (!row || typeof row !== 'object') continue
      const day = typeof row.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day) ? row.day : ''
      if (!day) continue
      const debit = round6(num(row.debit ?? row.cost))
      rows.push({
        day,
        cost: round6(num(row.cost ?? row.debit)),
        debit,
        credit: round6(num(row.credit)),
        opening: round6(num(row.opening)),
        closing: round6(num(row.closing)),
        firstAt: num(row.firstAt),
        lastAt: num(row.lastAt),
        complete: row.complete === true,
        origin: 'monitor',
      })
    }
    if (rows.length === 0) return null
    rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    return rows
  }

  /**
   * 双源日记账的**观测级合并**（契约 §7.8）。
   *
   * 两个来源对同一天各自只看到一段窗口：native 可能从更晚开始但结束更近，whale 可能从
   * 零点之前就开始但结束更早。整行二选一必然丢掉一端，所以这里把两行还原成观测点：
   *   native: {firstAt, opening}、{lastAt, closing}
   *   whale : {firstAt, opening}、{lastAt, closing}
   * 按 `at` 升序（同一时刻只保留一条，优先 native 的 balance），再用与 lib/account.js
   * `observeLedger()` 相同的回放算法累计：`delta = lastUnits - units`，delta>0 记 debit、
   * delta<0 记 credit。于是 opening = 最早观测、closing = 最新观测、debit 覆盖中间所有净下降。
   */
  function mergeDualSourceDay(nativeRow, whaleRow) {
    const observations = []
    const addObservation = (at, balance, preference) => {
      if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(balance)) return
      observations.push({ at, balance, preference })
    }
    // preference：0 = native，1 = whale；同一时刻排序时 native 在前，去重时保留它。
    addObservation(nativeRow.firstAt, nativeRow.opening, 0)
    addObservation(nativeRow.lastAt, nativeRow.closing, 0)
    addObservation(whaleRow.firstAt, whaleRow.opening, 1)
    addObservation(whaleRow.lastAt, whaleRow.closing, 1)
    if (observations.length === 0) return null
    observations.sort((left, right) => left.at - right.at || left.preference - right.preference)
    const points = []
    for (const observation of observations) {
      const previous = points.length > 0 ? points[points.length - 1] : null
      if (previous && previous.at === observation.at) continue // 同一时刻不重复计 delta
      points.push(observation)
    }
    if (points.length === 0) return null

    let lastUnits = Math.round(points[0].balance * UNITS_PER_CNY)
    const openingUnits = lastUnits
    let debitUnits = 0
    let creditUnits = 0
    for (let index = 1; index < points.length; index += 1) {
      const units = Math.round(points[index].balance * UNITS_PER_CNY)
      const delta = lastUnits - units
      if (delta > 0) debitUnits += delta
      else if (delta < 0) creditUnits -= delta
      lastUnits = units
    }

    const day = nativeRow.day
    const firstAt = points[0].at
    const lastAt = points[points.length - 1].at
    const midnight = startOfLocalDayKey(day)
    const todayKey = dayKeyOf(Date.now())
    const startCovered = midnight === null || firstAt <= midnight + NATIVE_EDGE_TOLERANCE_MS
    const endCovered =
      day >= todayKey || (midnight !== null && lastAt >= midnight + 86_400_000 - NATIVE_EDGE_TOLERANCE_MS)
    return {
      day,
      cost: round6(debitUnits / UNITS_PER_CNY),
      debit: round6(debitUnits / UNITS_PER_CNY),
      credit: round6(creditUnits / UNITS_PER_CNY),
      opening: round6(openingUnits / UNITS_PER_CNY),
      closing: round6(lastUnits / UNITS_PER_CNY),
      firstAt,
      lastAt,
      complete: startCovered && endCovered,
      origin: 'monitor+whale',
    }
  }

  /**
   * 合并 native + whale：
   *   - 双源都有的日期 → `mergeDualSourceDay()`（origin `'monitor+whale'`）；
   *   - 单来源日期直接透传（origin `'monitor'` / `'whale'`），保持原有 complete 语义。
   * 顶层 `source` 由实际贡献方决定；`legacySource` 供旧客户端回退。
   */
  function mergedState() {
    const whale = load()
    const whaleDays =
      whale.available === true && Array.isArray(whale.days)
        ? whale.days.map((row) => ({ ...row, origin: 'whale' }))
        : []
    const nativeDays = readNative()
    const grouped = new Map()
    for (const row of whaleDays) grouped.set(row.day, { whale: row, native: null })
    if (nativeDays) {
      for (const row of nativeDays) {
        const existing = grouped.get(row.day)
        if (existing) existing.native = row
        else grouped.set(row.day, { whale: null, native: row })
      }
    }

    const days = []
    let monitorOnly = 0
    let whaleOnly = 0
    let dual = 0
    for (const group of grouped.values()) {
      if (group.native && group.whale) {
        const mergedDay = mergeDualSourceDay(group.native, group.whale)
        if (mergedDay) {
          days.push(mergedDay)
          dual += 1
        } else {
          days.push(group.native)
          monitorOnly += 1
        }
      } else if (group.native) {
        days.push(group.native)
        monitorOnly += 1
      } else {
        days.push(group.whale)
        whaleOnly += 1
      }
    }
    days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))

    const nativeCount = monitorOnly + dual
    const whaleCount = whaleOnly + dual
    const available = days.length > 0
    const source =
      dual > 0 || (monitorOnly > 0 && whaleOnly > 0) ? 'monitor+whale' : monitorOnly > 0 ? 'monitor' : 'whale'
    let diag = ''
    if (!available) {
      diag = '没有可用的账本数据：本插件自建余额账本暂无观测，也未找到可回填的小鲸鱼账本文件'
    } else if (whaleCount > 0 && typeof whale.diag === 'string' && whale.diag !== '') {
      diag = `小鲸鱼账本回填：${whale.diag}`
    }
    const whaleMeta = cachedMeta
    const ageMs =
      whaleMeta && Number.isFinite(whaleMeta.mtimeMs) ? Math.max(0, Date.now() - num(whaleMeta.mtimeMs)) : null
    return {
      available,
      source,
      legacySource: 'wallet-ledger',
      currency: 'CNY',
      days,
      nativeCount,
      whaleCount,
      dualCount: dual,
      since: days.length > 0 ? days[0].day : null,
      until: days.length > 0 ? days[days.length - 1].day : null,
      whaleAgeMs: ageMs,
      diag,
    }
  }

  /** @type {ReturnType<typeof parseBillHistory>|null} */
  let cached = null
  /** 缓存对应的源文件指纹。 */
  let cachedMeta = null
  let lastDiag = ''
  let disposed = false
  /** 诊断计数：源文件真实读取次数 / 缓存命中次数（tools/bill-history-check.mjs 用它验证不重读）。 */
  let sourceReads = 0
  let cacheHits = 0
  let lastLoadFromCache = false

  /** 读取源文件（真实 IO）。 */
  function readSource() {
    try {
      const stat = statSync(file)
      const text = readFileSync(file, 'utf8')
      sourceReads += 1
      const parsed = JSON.parse(text)
      return { root: parsed, meta: { mtimeMs: num(stat.mtimeMs), size: num(stat.size) } }
    } catch (error) {
      const code = error && error.code ? String(error.code) : ''
      const message =
        code === 'ENOENT'
          ? `未找到余额账本文件：${file}`
          : `余额账本读取失败：${errorMessage(error)}`.slice(0, 200)
      return { root: null, meta: null, error: message }
    }
  }

  /** 尝试从落盘缓存恢复（源文件指纹一致才用）。 */
  function readDiskCache(meta) {
    if (!meta) return null
    const data = readJson(cacheFile)
    if (!data || typeof data !== 'object') return null
    if (data.version !== CACHE_VERSION) return null
    const source = data.source && typeof data.source === 'object' ? data.source : null
    if (!source) return null
    if (num(source.mtimeMs) !== num(meta.mtimeMs) || num(source.size) !== num(meta.size)) return null
    const state = data.state && typeof data.state === 'object' ? data.state : null
    if (!state || state.available !== true || !Array.isArray(state.days)) return null
    const days = state.days
      .filter((row) => row && typeof row === 'object' && typeof row.day === 'string')
      .map((row) => ({
        day: row.day,
        cost: num(row.cost),
        debit: num(row.debit ?? row.cost),
        credit: num(row.credit),
        opening: num(row.opening),
        closing: num(row.closing),
        firstAt: num(row.firstAt),
        lastAt: num(row.lastAt),
        complete: row.complete === true,
      }))
    if (days.length === 0) return null
    return {
      available: true,
      source: 'wallet-ledger',
      currency: 'CNY',
      days,
      since: typeof state.since === 'string' ? state.since : days[0].day,
      until: typeof state.until === 'string' ? state.until : days[days.length - 1].day,
      diag: typeof state.diag === 'string' ? state.diag : '',
    }
  }

  /** 落盘解析结果（失败静默）。 */
  function saveDiskCache(state, meta) {
    if (!meta) return
    writeJsonAtomic(cacheFile, {
      version: CACHE_VERSION,
      savedAt: Date.now(),
      source: { file, mtimeMs: meta.mtimeMs, size: meta.size },
      state: {
        available: state.available,
        source: state.source,
        currency: state.currency,
        days: state.days,
        since: state.since,
        until: state.until,
        diag: state.diag,
      },
    })
  }

  /**
   * 读取并解析账本（带内存 + 落盘缓存；同步、绝不抛）。
   * @returns {{available:boolean,source:string,currency:'CNY',days:Array,since:string|null,until:string|null,diag:string}}
   */
  function load() {
    if (disposed) {
      return { available: false, source: 'wallet-ledger', currency: 'CNY', days: [], since: null, until: null, diag: '已卸载' }
    }
    let stat = null
    try {
      stat = statSync(file)
    } catch {
      stat = null
    }
    const meta = stat ? { mtimeMs: num(stat.mtimeMs), size: num(stat.size) } : null

    // ① 内存缓存命中：源文件指纹未变，直接返回。
    if (cached && cachedMeta && (!meta || (num(meta.mtimeMs) === num(cachedMeta.mtimeMs) && num(meta.size) === num(cachedMeta.size)))) {
      cacheHits += 1
      lastLoadFromCache = true
      return cached
    }
    // ② 落盘缓存命中（跨进程重启）。
    if (meta) {
      const disk = readDiskCache(meta)
      if (disk) {
        cached = disk
        cachedMeta = meta
        cacheHits += 1
        lastLoadFromCache = true
        lastDiag = disk.diag
        return cached
      }
    }
    // ③ 真实读源文件。
    lastLoadFromCache = false
    const read = readSource()
    if (read.root === null) {
      cached = {
        available: false,
        source: 'wallet-ledger',
        currency: 'CNY',
        days: [],
        since: null,
        until: null,
        diag: read.error || '余额账本不可用',
      }
      cachedMeta = meta
      lastDiag = cached.diag
      return cached
    }
    cached = parseBillHistory(read.root, '')
    cachedMeta = read.meta
    lastDiag = cached.diag
    if (cached.available) saveDiskCache(cached, cachedMeta)
    return cached
  }

  /** 窗口内（含今天）的日期键列表：`days` 为天数，null = 全部。 */
  function windowDayKeys(now, days) {
    if (days === null) return null
    const keys = []
    const base = startOfLocalDayKey(dayKeyOf(now))
    if (base === null) return keys
    for (let offset = days - 1; offset >= 0; offset -= 1) keys.push(dayKeyOf(base - offset * 86_400_000))
    return keys
  }

  /**
   * 计算某个窗口的天数合计（只统计账本里存在的日期）。
   * `credit` 是该窗口内的充值合计（按天 creditUnits 求和），供 /account 的 `hasTopUp` 辅助判断。
   */
  function sumWindow(state, now, days) {
    if (!state || state.available !== true || !Array.isArray(state.days)) {
      return { cost: 0, credit: 0, complete: false, covered: 0, expected: days === null ? state?.days?.length ?? 0 : days }
    }
    const keys = windowDayKeys(now, days)
    const byKey = new Map(state.days.map((row) => [row.day, row]))
    if (keys === null) {
      const cost = state.days.reduce((sum, row) => sum + num(row.cost), 0)
      const credit = state.days.reduce((sum, row) => sum + num(row.credit), 0)
      return {
        cost: round6(cost),
        credit: round6(credit),
        complete: false,
        covered: state.days.length,
        expected: state.days.length,
      }
    }
    let cost = 0
    let credit = 0
    let covered = 0
    let allComplete = true
    for (const key of keys) {
      const row = byKey.get(key)
      if (row) {
        cost += num(row.cost)
        credit += num(row.credit)
        covered += 1
        if (row.complete !== true) allComplete = false
      } else {
        allComplete = false
      }
    }
    return {
      cost: round6(cost),
      credit: round6(credit),
      complete: covered === keys.length && allComplete,
      covered,
      expected: keys.length,
    }
  }

  /**
   * 供 `/account` 使用：四个消费窗口 + 完整性与新鲜度（契约 §7.4 / §7.8）。
   * @param {number} [now]
   */
  function windows(now) {
    const at = Number.isFinite(now) ? now : Date.now()
    const state = mergedState()
    const available = state.available === true
    const ageMs = cachedMeta && Number.isFinite(cachedMeta.mtimeMs) ? Math.max(0, at - num(cachedMeta.mtimeMs)) : null
    // native 账本随采样实时更新，所以只要它贡献了日期就视为新鲜；纯 whale 才看文件 mtime。
    const fresh = available && (state.nativeCount > 0 || (ageMs !== null && ageMs <= FRESH_TOLERANCE_MS))
    const today = sumWindow(state, at, 1)
    const yesterday = sumWindow(state, at - 86_400_000, 1)
    const last7d = sumWindow(state, at, 7)
    const last30d = sumWindow(state, at, 30)
    const all = sumWindow(state, at, null)
    // 单日窗口的 fromAt：账本里存在该日时用本地零点，否则 null。
    const fromAtOf = (row, offsetDays) => {
      if (!available || !row || row.covered === 0) return null
      const base = startOfLocalDayKey(dayKeyOf(at - offsetDays * 86_400_000))
      return base
    }
    return {
      available,
      fresh,
      source: state.source,
      legacySource: state.legacySource,
      ageMs,
      spend: {
        today: today.cost,
        yesterday: yesterday.cost,
        last7d: last7d.cost,
        last30d: last30d.cost,
      },
      complete: {
        today: today.complete === true,
        yesterday: yesterday.complete === true,
        last7d: last7d.complete === true,
        last30d: last30d.complete === true,
      },
      // 窗口内充值合计（CNY）：/account 用它把「账本窗口内出现充值」补进 hasTopUp。
      credit: {
        today: today.credit,
        yesterday: yesterday.credit,
        last7d: last7d.credit,
        last30d: last30d.credit,
      },
      coverage: {
        today: { fromAt: fromAtOf(today, 0), complete: today.complete === true },
        yesterday: { fromAt: fromAtOf(yesterday, 1), complete: yesterday.complete === true },
        last7d: { fromAt: last7d.covered === 7 ? fromAtOf(last7d, 6) : null, complete: last7d.complete === true },
        last30d: { fromAt: last30d.covered === 30 ? fromAtOf(last30d, 29) : null, complete: last30d.complete === true },
      },
      all,
      diag: state.diag || '',
    }
  }

  /**
   * 契约 §7.8 的 HTTP 视图。
   * @param {{range?:string, now?:number}} [options]
   */
  function snapshot(optionsIn) {
    const opts = optionsIn && typeof optionsIn === 'object' ? optionsIn : {}
    const now = Number.isFinite(opts.now) ? opts.now : Date.now()
    const requested = typeof opts.range === 'string' ? opts.range : '30d'
    const rangeKey = Object.prototype.hasOwnProperty.call(RANGE_DAYS, requested) ? requested : '30d'
    try {
      const state = mergedState()
      const days = state.available === true ? state.days : []
      const keys = windowDayKeys(now, RANGE_DAYS[rangeKey])
      const filtered = keys === null ? days : days.filter((row) => keys.includes(row.day))
      const totals = {}
      for (const key of Object.keys(RANGE_DAYS)) totals[key] = { cost: sumWindow(state, now, RANGE_DAYS[key]).cost }
      const ageMs = cachedMeta && Number.isFinite(cachedMeta.mtimeMs) ? Math.max(0, now - num(cachedMeta.mtimeMs)) : 0
      return {
        generatedAt: now,
        available: state.available === true,
        source: state.source,
        legacySource: 'wallet-ledger',
        currency: 'CNY',
        range: { key: rangeKey, label: RANGE_LABELS[rangeKey] },
        days: filtered,
        since: filtered.length > 0 ? filtered[0].day : null,
        until: filtered.length > 0 ? filtered[filtered.length - 1].day : null,
        totals,
        freshness: {
          fileMtime: cachedMeta ? num(cachedMeta.mtimeMs) : 0,
          ageMs,
          nativeDays: state.nativeCount,
          whaleDays: state.whaleCount,
        },
        diag: state.diag || '',
      }
    } catch (error) {
      return {
        generatedAt: now,
        available: false,
        source: 'whale',
        legacySource: 'wallet-ledger',
        currency: 'CNY',
        range: { key: rangeKey, label: RANGE_LABELS[rangeKey] },
        days: [],
        since: null,
        until: null,
        totals: { '7d': { cost: 0 }, '14d': { cost: 0 }, '30d': { cost: 0 }, all: { cost: 0 } },
        freshness: { fileMtime: 0, ageMs: 0, nativeDays: 0, whaleDays: 0 },
        diag: `余额账本视图构建失败: ${errorMessage(error)}`.slice(0, 200),
      }
    }
  }

  /** 幂等卸载：丢掉内存缓存（落盘缓存保留，供下次启动复用）。 */
  function dispose() {
    if (disposed) return
    disposed = true
    cached = null
    cachedMeta = null
  }

  /** 诊断信息（tools 用）。 */
  function stats() {
    const whale = cached
    const native = readNative()
    return {
      file,
      cacheFile,
      available: (whale ? whale.available === true : false) || native !== null,
      days: whale && Array.isArray(whale.days) ? whale.days.length : 0,
      nativeDays: native ? native.length : 0,
      source: native && native.length > 0 ? 'monitor' : 'whale',
      sourceReads,
      cacheHits,
      lastLoadFromCache,
      fileMtime: cachedMeta ? num(cachedMeta.mtimeMs) : 0,
      fileSize: cachedMeta ? num(cachedMeta.size) : 0,
      diag: lastDiag,
      disposed,
    }
  }

  return { load, snapshot, windows, dispose, stats }
}
