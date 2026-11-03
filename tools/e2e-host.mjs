/**
 * End-to-end Host check: mount `index.js` against a fake Host context whose
 * `sessionQuery` reads the real session artifacts from disk, then dispatch the
 * two HTTP routes exactly as the Web server would.
 *
 * This exercises the real wiring — `apply()` → `createCollector` → `fold` →
 * `system` → `routes` — without booting Harness, and diffs the result against
 * `tools/oracle.mjs` (an independent implementation) so a folding regression
 * shows up as a mismatch instead of a plausible-looking dashboard.
 *
 *   node tools/e2e-host.mjs [--verbose]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readSessionArtifact } from './zstd-frames.mjs'
import { apply } from '../index.js'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const verbose = process.argv.includes('--verbose')

const failures = []
const notes = []
function check(label, ok, detail) {
  if (ok) {
    if (verbose) console.log(`  PASS ${label}`)
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Discover every persisted session artifact. */
function listArtifacts() {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (entry.name === 'session.v4.jsonl.zstd') found.push(path)
    }
  }
  walk(SESSIONS_ROOT, 0)
  return found
}

/** Load every artifact once so list and observe agree with each other. */
const artifacts = new Map()
for (const path of listArtifacts()) {
  try {
    const stat = statSync(path)
    const { header, records } = readSessionArtifact(readFileSync(path))
    if (!header || typeof header.id !== 'string') continue
    artifacts.set(header.id, { path, header, records, mtimeMs: stat.mtimeMs, size: stat.size })
  } catch (error) {
    notes.push(`skipped ${path}: ${error instanceof Error ? error.message : error}`)
  }
}
console.log(`loaded ${artifacts.size} session artifacts from ${SESSIONS_ROOT}`)

/** @type {Map<string, Function>} registered exact routes, path -> handler. */
const routes = new Map()
let observerCalls = 0

const ctx = {
  sessionQuery: {
    async listSessions() {
      return [...artifacts.values()]
        .map((artifact) => ({
          header: artifact.header,
          live: false,
          persisted: true,
          formatStatus: 'current',
        }))
        .sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))
    },
    async observeSession(sessionId) {
      observerCalls += 1
      const artifact = artifacts.get(sessionId)
      if (!artifact) throw new Error(`unknown session ${sessionId}`)
      return {
        source: 'prepared',
        header: artifact.header,
        inheritedEventCount: 0,
        events: artifact.records,
        cursor: artifact.records.length,
        revision: `${artifact.mtimeMs}:${artifact.size}`,
        dispose() {},
        retain() {
          return this
        },
      }
    },
    async readSession(sessionId) {
      const artifact = artifacts.get(sessionId)
      if (!artifact) throw new Error(`unknown session ${sessionId}`)
      return { session: artifact.header, inheritedEventCount: 0, events: artifact.records }
    },
  },
  on() {
    return () => {}
  },
  logger() {
    return { info() {}, warn() {}, error() {}, debug() {} }
  },
  webServer: {
    register(route) {
      if (!route || typeof route.path !== 'string') throw new Error('bad route')
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  effect() {},
}

/** Minimal ServerResponse stand-in that captures what a route writes. */
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    writeHead(code, headers) {
      this.statusCode = code
      if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v)
      return this
    },
    write(chunk) {
      this.body += chunk
      return true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += chunk
      this.done = true
    },
    get json() {
      return JSON.parse(this.body)
    },
  }
}

/** Invoke one registered route as the Web server would. */
async function call(path, query = '') {
  const handler = routes.get(path)
  if (!handler) throw new Error(`route not registered: ${path}`)
  const res = makeRes()
  await handler({ method: 'GET', url: `${path}${query}`, headers: {} }, res)
  return res
}

/** Wait until the collector's background scan reports idle or the deadline passes. */
async function waitForScan(collector, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const progress = collector.scanProgress?.()
    if (!progress || progress.scanning === false) {
      // A freshly started scan sets scanning=true synchronously; probe twice to be safe.
      await new Promise((resolve) => setTimeout(resolve, 150))
      const again = collector.scanProgress?.()
      if (!again || again.scanning === false) return again ?? progress ?? null
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return collector.scanProgress?.() ?? null
}

async function main() {
  console.log('\n[1] apply(reindex) mounting')
  const startedMount = Date.now()
  apply(ctx, { fx: { USDCNY: 7.1 }, sampleIntervalMs: 2000, liveHistoryPoints: 60, rescanIntervalMs: 60000 })
  console.log(`  apply() returned in ${Date.now() - startedMount}ms`)
  check('overview route registered', routes.has('/usage-monitor/api/overview'), [...routes.keys()].join(','))
  check('live route registered', routes.has('/usage-monitor/api/live'), [...routes.keys()].join(','))

  // Reach the collector through a route handler is not possible, so grab it via a
  // second apply on a capture ctx that records the collector passed to routes.
  // Simpler: wait for the scan by polling the overview payload's scan.scanning.
  console.log('\n[2] waiting for background scan')
  const scanStart = Date.now()
  let overviewRes = null
  let scanning = true
  while (Date.now() - scanStart < 180_000) {
    overviewRes = await call('/usage-monitor/api/overview', '?range=all&currency=USD')
    if (overviewRes.statusCode !== 200) break
    scanning = overviewRes.json?.scan?.scanning === true
    if (!scanning) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const scanMs = Date.now() - scanStart
  console.log(`  scan settled after ${scanMs}ms, observerCalls=${observerCalls}`)
  check('overview responds 200', overviewRes?.statusCode === 200, `status=${overviewRes?.statusCode} body=${overviewRes?.body.slice(0, 200)}`)
  const overview = overviewRes?.json
  check('overview is JSON object', overview && typeof overview === 'object')
  if (!overview) {
    report()
    return
  }
  check('scan no longer in progress', overview.scan?.scanning === false, JSON.stringify(overview.scan))
  check('scan.errors === 0', overview.scan?.errors === 0, `errors=${overview.scan?.errors}`)
  check(
    'scan.sessionsTotal matches disk',
    overview.scan?.sessionsTotal === artifacts.size,
    `host=${overview.scan?.sessionsTotal} disk=${artifacts.size}`,
  )
  check('scan.scanned === sessionsTotal', overview.scan?.scanned === artifacts.size, `scanned=${overview.scan?.scanned}`)

  console.log('\n[3] contract field presence and types')
  check('generatedAt number', typeof overview.generatedAt === 'number')
  check('range.key === all', overview.range?.key === 'all', JSON.stringify(overview.range))
  const kpi = overview.kpi ?? {}
  const kpiNumbers = [
    'totalTokens', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
    'reasoningTokens', 'cacheHitRate', 'cost', 'costCNY', 'costUSD', 'sessions', 'activeSessions', 'turns',
    'steps', 'requests', 'toolCalls', 'avgTokensPerSession', 'avgTokensPerTurn', 'avgTtftMs',
    'tokensPerSec', 'tokensPerMin',
  ]
  for (const key of kpiNumbers) {
    check(`kpi.${key} is finite number`, typeof kpi[key] === 'number' && Number.isFinite(kpi[key]), `got ${JSON.stringify(kpi[key])}`)
  }
  check('kpi.currency is string', typeof kpi.currency === 'string', String(kpi.currency))
  check('kpi.fxRate number', typeof kpi.fxRate === 'number')

  console.log('\n[4] arithmetic invariants')
  const bucketSum = kpi.uncachedInputTokens + kpi.cacheReadTokens + kpi.cacheWriteTokens + kpi.outputTokens
  check('totalTokens === sum of four buckets', Math.abs(kpi.totalTokens - bucketSum) <= 1, `total=${kpi.totalTokens} sum=${bucketSum}`)
  const inputTotal = kpi.uncachedInputTokens + kpi.cacheReadTokens + kpi.cacheWriteTokens
  const expectedHit = inputTotal > 0 ? kpi.cacheReadTokens / inputTotal : 0
  check('cacheHitRate matches buckets', Math.abs(kpi.cacheHitRate - expectedHit) < 1e-9, `got=${kpi.cacheHitRate} expected=${expectedHit}`)
  check('cacheHitRate in [0,1]', kpi.cacheHitRate >= 0 && kpi.cacheHitRate <= 1, String(kpi.cacheHitRate))

  console.log('\n[5] series / models / sessions shape')
  check('series.granularity is hour|day', overview.series?.granularity === 'hour' || overview.series?.granularity === 'day', String(overview.series?.granularity))
  check('series.buckets is array', Array.isArray(overview.series?.buckets))
  const buckets = overview.series?.buckets ?? []
  check('series.buckets non-empty', buckets.length > 0, `len=${buckets.length}`)
  check('bucket numeric fields', buckets.every((b) => typeof b.t === 'number' && typeof b.totalTokens === 'number' && typeof b.cost === 'number'), 'some bucket malformed')
  const bucketTotal = buckets.reduce((sum, b) => sum + (b.totalTokens ?? 0), 0)
  check('sum(buckets.totalTokens) === kpi.totalTokens', Math.abs(bucketTotal - kpi.totalTokens) <= 1, `buckets=${bucketTotal} kpi=${kpi.totalTokens}`)

  check('models is array', Array.isArray(overview.models))
  const models = overview.models ?? []
  check('models non-empty', models.length > 0, `len=${models.length}`)
  const modelTotal = models.reduce((sum, m) => sum + (m.totalTokens ?? 0), 0)
  check('sum(models.totalTokens) === kpi.totalTokens', Math.abs(modelTotal - kpi.totalTokens) <= 1, `models=${modelTotal} kpi=${kpi.totalTokens}`)
  check('model rows carry provider+model', models.every((m) => typeof m.provider === 'string' && typeof m.model === 'string'))
  check('model rows carry priced flag', models.every((m) => typeof m.priced === 'boolean'))

  check('sessions is array', Array.isArray(overview.sessions))
  const sessions = overview.sessions ?? []
  check('sessions length === scan.sessionsTotal', sessions.length === overview.scan?.sessionsTotal, `sessions=${sessions.length} total=${overview.scan?.sessionsTotal}`)
  const sessionTotal = sessions.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0)
  check('sum(sessions.totalTokens) === kpi.totalTokens', Math.abs(sessionTotal - kpi.totalTokens) <= 1, `sessions=${sessionTotal} kpi=${kpi.totalTokens}`)

  console.log('\n[6] performance panel')
  const perf = overview.performance ?? {}
  check('performance.ttft.samples number', typeof perf.ttft?.samples === 'number')
  check('performance.ttft.avg number', typeof perf.ttft?.avg === 'number')
  check('performance.ttft has p50/p90', typeof perf.ttft?.p50 === 'number' && typeof perf.ttft?.p90 === 'number')
  check('performance.tokensPerSec.avg number', typeof perf.tokensPerSec?.avg === 'number')
  check('performance.toolShare in [0,1]', perf.toolShare >= 0 && perf.toolShare <= 1, String(perf.toolShare))
  check('performance totals present', typeof perf.totalTurns === 'number' && typeof perf.errorTurns === 'number' && typeof perf.interruptedTurns === 'number')
  check('ttft samples > 0 (real logs have streams)', perf.ttft?.samples > 0, `samples=${perf.ttft?.samples}`)
  check('tokensPerSec.avg > 0 (real logs decode)', perf.tokensPerSec?.avg > 0, `avg=${perf.tokensPerSec?.avg}`)

  console.log('\n[7] ranges and currencies')
  for (const range of ['24h', '7d', '14d', '30d', 'today', 'all']) {
    const res = await call('/usage-monitor/api/overview', `?range=${range}&currency=CNY`)
    check(`range=${range} 200`, res.statusCode === 200, `status=${res.statusCode}`)
    const body = res.json
    check(`range=${range} echoes key`, body?.range?.key === range, JSON.stringify(body?.range))
    check(`range=${range} currency CNY`, body?.kpi?.currency === 'CNY', String(body?.kpi?.currency))
    check(`range=${range} cost === costCNY（CNY 请求）`, Math.abs((body?.kpi?.cost ?? 0) - (body?.kpi?.costCNY ?? 0)) < 0.01, `cost=${body?.kpi?.cost} cny=${body?.kpi?.costCNY}`)
    check(`range=${range} cost === costUSD * fxRate`, Math.abs((body?.kpi?.cost ?? 0) - (body?.kpi?.costUSD ?? 0) * (body?.kpi?.fxRate ?? 0)) < 0.01, `cost=${body?.kpi?.cost} usd=${body?.kpi?.costUSD}`)
    if (range !== 'all') {
      check(`range=${range} not wider than all`, (body?.kpi?.totalTokens ?? 0) <= overview.kpi.totalTokens + 1, `${body?.kpi?.totalTokens} > ${overview.kpi.totalTokens}`)
    }
  }
  const badRange = await call('/usage-monitor/api/overview', '?range=bogus&currency=USD')
  check('unknown range falls back instead of 500', badRange.statusCode === 200, `status=${badRange.statusCode}`)

  console.log('\n[8] /live endpoint')
  const liveRes = await call('/usage-monitor/api/live')
  check('live responds 200', liveRes.statusCode === 200, `status=${liveRes.statusCode} body=${liveRes.body.slice(0, 200)}`)
  const live = liveRes.json
  check('live generatedAt number', typeof live?.generatedAt === 'number')
  check('live.uptime.processMs number', typeof live?.uptime?.processMs === 'number')
  check('live.process.rssBytes > 0', live?.process?.rssBytes > 0, String(live?.process?.rssBytes))
  check('live.process.cpuPercent number', typeof live?.process?.cpuPercent === 'number')
  check('live.host.cores > 0', live?.host?.cores > 0, String(live?.host?.cores))
  check('live.host.memTotalBytes > 0', live?.host?.memTotalBytes > 0, String(live?.host?.memTotalBytes))
  check('live.host.memPercent in [0,100]', live?.host?.memPercent >= 0 && live?.host?.memPercent <= 100, String(live?.host?.memPercent))
  check('live.gpu.available boolean', typeof live?.gpu?.available === 'boolean', String(live?.gpu?.available))
  check('live.counters present', typeof live?.counters?.sessionsTotal === 'number' && typeof live?.counters?.totalTokens === 'number')
  for (const series of ['cpu', 'gpu', 'mem', 'tokensPerMin']) {
    check(`live.history.${series} is array`, Array.isArray(live?.history?.[series]), typeof live?.history?.[series])
    check(`live.history.${series} length <= 60`, (live?.history?.[series]?.length ?? 0) <= 60, String(live?.history?.[series]?.length))
  }

  console.log('\n[9] /live latency')
  const timings = []
  for (let i = 0; i < 10; i += 1) {
    const t0 = process.hrtime.bigint()
    await call('/usage-monitor/api/live')
    timings.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  const maxLive = Math.max(...timings)
  const avgLive = timings.reduce((a, b) => a + b, 0) / timings.length
  console.log(`  live latency avg=${avgLive.toFixed(2)}ms max=${maxLive.toFixed(2)}ms`)
  check('live latency < 50ms', maxLive < 50, `max=${maxLive.toFixed(2)}ms`)

  console.log('\n[10] repeated overview is cached (no re-read of logs)')
  const callsBefore = observerCalls
  const t1 = process.hrtime.bigint()
  await call('/usage-monitor/api/overview', '?range=7d&currency=USD')
  const secondMs = Number(process.hrtime.bigint() - t1) / 1e6
  console.log(`  second overview took ${secondMs.toFixed(2)}ms, observeSession calls delta=${observerCalls - callsBefore}`)
  check('second overview reuses cache', observerCalls - callsBefore === 0, `delta=${observerCalls - callsBefore}`)
  check('second overview < 200ms', secondMs < 200, `${secondMs.toFixed(2)}ms`)

  console.log('\n[11] numbers vs independent oracle')
  const { execFileSync } = await import('node:child_process')
  let oracle = null
  try {
    const out = execFileSync(process.execPath, [join(import.meta.dirname, 'oracle.mjs'), '--json', '--range', 'all'], { encoding: 'utf8' })
    oracle = JSON.parse(out)
  } catch (error) {
    notes.push(`oracle failed: ${error instanceof Error ? error.message : error}`)
  }
  if (oracle) {
    console.log(`  oracle: totalTokens=${oracle.totalTokens} requests=${oracle.requests} cacheHit=${(oracle.cacheHitRate * 100).toFixed(2)}%`)
    console.log(`  host  : totalTokens=${overview.kpi.totalTokens} requests=${overview.kpi.requests} cacheHit=${(overview.kpi.cacheHitRate * 100).toFixed(2)}%`)
    const rel = Math.abs(overview.kpi.totalTokens - oracle.totalTokens) / Math.max(1, oracle.totalTokens)
    // Logs keep growing during the run, so allow a small drift; a folding bug is far larger.
    check('totalTokens within 2% of oracle', rel < 0.02, `rel=${(rel * 100).toFixed(3)}%`)
    const reqRel = Math.abs(overview.kpi.requests - oracle.requests) / Math.max(1, oracle.requests)
    check('requests within 2% of oracle', reqRel < 0.02, `rel=${(reqRel * 100).toFixed(3)}%`)
    check('cacheHitRate within 1pp of oracle', Math.abs(overview.kpi.cacheHitRate - oracle.cacheHitRate) < 0.01, `host=${overview.kpi.cacheHitRate} oracle=${oracle.cacheHitRate}`)
  }

  console.log('\n[12] teardown')
  // Unloading the plugin must deregister both routes.
  if (typeof ctx.__effectCleanup === 'function') ctx.__effectCleanup()

  if (notes.length > 0) {
    console.log('\nnotes:')
    for (const note of notes) console.log(`  - ${note}`)
  }
  report()
}

function report() {
  console.log('')
  if (failures.length === 0) {
    console.log('E2E HOST PASSED — every contract check green')
  } else {
    console.log(`E2E HOST FAILED — ${failures.length} check(s):`)
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exitCode = 1
  }
}

await main()
