/**
 * Host half of the `dsh-usage-monitor` bundle.
 *
 * Responsibilities, in order:
 *   1. build the collector that folds every persisted and live session log into
 *      usage counters (`lib/collect.js`), sampling CPU/GPU/memory alongside it
 *      (`lib/system.js`),
 *   2. own the two **v2** sources that make the numbers line up with the DeepSeek
 *      platform: the `llm/stream` ledger (`lib/llm-ledger.js`) that counts every
 *      model call — including the Auto review / title / compaction calls the
 *      session log never records — and the account probe (`lib/account.js`) that
 *      identifies the signed-in account and reads its wallet balance,
 *   3. publish read-only JSON routes on the Host web server (`lib/routes.js`),
 *      which the browser half polls,
 *   4. own every registration as an effect of this plugin's fiber, so unloading
 *      the plugin removes the routes, the samplers and the caches.
 *
 * The browser half (`lib/client.js`) is registered by the same bundle row via
 * `dsh.client`; this module never renders anything.
 *
 * All state is a derived cache: session logs stay the single source of truth for
 * conversation usage, and the ledger caches provider-reported token usage (so
 * the plugin never writes session events, and a restart is not a data loss — it
 * is a re-read plus a re-aggregation).
 */

import { createCollector } from './lib/collect.js'
import { createLlmLedger } from './lib/llm-ledger.js'
import { createAccountProbe } from './lib/account.js'
import { createBillHistory } from './lib/bill-history.js'
import { createFxRate } from './lib/fx.js'
import { registerUsageRoutes } from './lib/routes.js'

/** Services this plugin cannot work without; the fiber stays pending otherwise. */
export const inject = ['webServer', 'sessionQuery', 'sessions']

/**
 * Mount the collector, the ledger, the account probe and their HTTP routes.
 *
 * `llm` and `deepseekAccount` are deliberately **not** in {@link inject}: they are
 * optional capabilities, read through `ctx.get(...)` by their own modules. Putting
 * them in `inject` would leave the whole plugin dormant on a host that lacks them,
 * which is strictly worse than losing one card.
 *
 * @param ctx - plugin context carrying the Host services listed in {@link inject}.
 * @param config - row config from `cordis.patch.yml`; every key has an in-code default.
 */
export function apply(ctx, config) {
  const disposers = []
  const settings = config ?? {}
  const extras = { ledger: null, account: null, billHistory: null, fxRate: null }

  const push = (disposer) => {
    if (typeof disposer === 'function') disposers.push(disposer)
  }

  // 0. 实时汇率（v4）：央行授权 CFETS 中间价，失败链 → CFETS 历史 → 第三方 → 配置兜底。
  //    构造期零 IO/零请求；start() 才读缓存并起 unref 定时刷新（契约 §7.9）。
  //    CNY 仍是成本权威：实时汇率只用于 `costUSD = costCNY / fxRate` 的派生展示。
  let fxRate = { getRate: () => null, refresh: async () => null, start() {}, dispose() {} }
  try {
    fxRate = createFxRate(ctx, {
      cacheFile: settings.fxFile,
      refreshIntervalMs: settings.fxRefreshIntervalMs,
      configRate: settings.fx?.USDCNY,
      timeoutMs: settings.fxTimeoutMs,
    })
  } catch (error) {
    reportFatal(ctx, 'fxRate', error)
  }
  push(() => fxRate.dispose())
  extras.fxRate = fxRate

  // 1. Session-log collector — the historical, per-session view.
  let collector = null
  try {
    collector = createCollector(ctx, settings, { fxRate })
    push(() => collector.dispose())
  } catch (error) {
    reportFatal(ctx, 'collector', error)
  }

  // 2. Ledger — counts *every* model call, including the ones no session event
  //    records. This is what makes `totalTokens` comparable to the platform.
  try {
    extras.ledger = createLlmLedger(ctx, {
      cacheFile: settings.ledgerFile,
      sampleIntervalMs: settings.sampleIntervalMs,
      // Same price table the session view uses, so the two cost numbers differ
      // only by *which calls are counted*, never by which prices were applied.
      pricing: settings.pricing,
      // 汇率只用于派生 USD 展示值；CNY 金额是权威值（契约 §2.1 / §7.3）。
      usdCnyRate: settings.fx?.USDCNY,
      // v4：实时汇率只用于派生 USD 展示与 fx 元数据（CNY 权威）。
      fxRate,
    })
    push(() => extras.ledger.dispose())
  } catch (error) {
    reportFatal(ctx, 'ledger', error)
    extras.ledger = null
  }

  // 3. Balance ledger — primary source is our own per-day ledger (built by the
  //    account probe below from `deepseekAccount.getBalance()` samples, persisted
  //    in `account.json`). The dsh-whale-widget file in `$DSH_HOME/.dshw-usage.json`
  //    is only an optional **read-only backfill** for days before installation.
  //    The native closure is lazy: `extras.account` is constructed after this
  //    block but only read when `/bill-history` or `/account` is served.
  try {
    extras.billHistory = createBillHistory({
      file: settings.billHistoryFile,
      cacheFile: settings.billHistoryCacheFile,
      native: () => {
        const account = extras.account
        return account && typeof account.dailyLedger === 'function' ? account.dailyLedger() : null
      },
    })
    push(() => extras.billHistory.dispose())
  } catch (error) {
    reportFatal(ctx, 'billHistory', error)
    extras.billHistory = null
  }

  // 4. Account probe — identifies the signed-in account and reads its balance.
  try {
    extras.account = createAccountProbe(ctx, {
      cacheFile: settings.accountFile,
      refreshIntervalMs: settings.accountRefreshIntervalMs,
      // 历史账本可用且新鲜时，/account 的 spend 优先用它（契约 §7.4 / §7.8）。
      billHistory: extras.billHistory,
    })
    push(() => extras.account.dispose())
  } catch (error) {
    reportFatal(ctx, 'account', error)
    extras.account = null
  }

  // 5. Routes need every module; each may be null and the route says so in `diag`.
  try {
    registerUsageRoutes(ctx, collector, disposers, extras)
  } catch (error) {
    reportFatal(ctx, 'routes', error)
  }

  // 6. Warm the historical ledger cache once, so the first `/bill-history` poll
  //    is not a cold read. `load()` is synchronous and never throws out.
  try {
    extras.billHistory?.load()
  } catch (error) {
    reportFatal(ctx, 'billHistory.load', error)
  }

  // Start after the routes exist, so the first poll never hits a half-built plugin.
  try {
    // 先启动汇率：start() 会同步读缓存（若 24h 内有效），首个 overview 就能带上真实中间价。
    fxRate?.start?.()
  } catch (error) {
    reportFatal(ctx, 'fxRate.start', error)
  }
  try {
    collector?.start()
  } catch (error) {
    reportFatal(ctx, 'collector.start', error)
  }
  try {
    extras.ledger?.start()
  } catch (error) {
    reportFatal(ctx, 'ledger.start', error)
  }
  try {
    extras.account?.start()
  } catch (error) {
    reportFatal(ctx, 'account.start', error)
  }

  ctx.effect(() => () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop()
      try {
        dispose()
      } catch (error) {
        reportFatal(ctx, 'dispose', error)
      }
    }
  })
}

/**
 * Surface an activation failure on the console and the plugin's logger without
 * throwing out of `apply`. A monitoring plugin must never take the application
 * down with it — a missing GPU, account or ledger degrades one card, not the app.
 *
 * @param ctx - plugin context.
 * @param stage - which step failed, for the log line.
 * @param error - the swallowed failure.
 */
function reportFatal(ctx, stage, error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  try {
    ctx.logger?.('usage-monitor')?.error?.(`usage monitor failure: ${stage}`, message)
  } catch {
    // A missing logger is not worth a second failure path.
  }
  // eslint-disable-next-line no-console
  console.error(`[usage-monitor] ${stage}:`, message)
}
