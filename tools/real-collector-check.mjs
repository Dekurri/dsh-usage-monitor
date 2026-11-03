/**
 * 真实数据 × collect.js 集成自测（不安装插件、不碰 profile）。
 *
 * 用真实全库日志（离线 zstd 解码）as a stub `ctx.sessionQuery`，驱动真实的
 * `createCollector()`，验证：
 *   1. 75 个会话后台扫描耗时（目标 <8s；含/不含 zstd 解码分别报）
 *   2. getOverview 在真实数据上的耗时（目标 <300ms）与折叠口径恒等
 *      （overview(all).kpi.totalTokens === 独立 fold 的合计）
 *   3. getLive 同步耗时（目标 <50ms，GPU 异步刷新）
 *   4. 落盘缓存在重启后生效：第二次启动 0 次冷读、overview 立即可用
 *
 * 用法：node tools/real-collector-check.mjs
 * 只读：不修改任何会话文件；临时缓存写在包内 .tmp/real-collector（结束删除）。
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createCollector } from '../lib/collect.js'
import { emptySessionStats, foldEvents, sumTokens } from '../lib/fold.js'
import { readSessionArtifact } from './zstd-frames.mjs'

const SESSION_FILE = 'session.v4.jsonl.zstd'
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const root = process.env.DSH_SESSIONS_ROOT || path.join(os.homedir(), '.dsh', 'sessions')
// 本机 os.tmpdir() 不可写（EPERM），临时缓存放到包内 .tmp/（测试结束删除）
const cacheDir = path.join(packageRoot, '.tmp', 'real-collector')

/** 找全部会话文件。 */
function findSessionFiles() {
  const found = []
  for (const entry of readdirSync(root, { recursive: true })) {
    if (!String(entry).endsWith(SESSION_FILE)) continue
    const absolute = path.join(root, String(entry))
    try {
      if (statSync(absolute).isFile()) found.push(absolute)
    } catch {
      // ignore
    }
  }
  found.sort()
  return found
}

// ── ① 离线解码（等价于 Host 的 sessionQuery 读盘成本，单独计时）──
const files = findSessionFiles()
const decodeStart = performance.now()
const artifacts = []
for (const file of files) {
  try {
    const artifact = readSessionArtifact(readFileSync(file))
    artifacts.push({ file, header: artifact.header ?? {}, records: artifact.records })
  } catch (error) {
    console.error(`解码失败 ${path.basename(path.dirname(file))}: ${error instanceof Error ? error.message : error}`)
  }
}
const decodeMs = performance.now() - decodeStart

// ── ② 独立 fold 基准（与 collector 走同一个 fold，但独立计时/独立对象）──
const baseline = {
  sessions: 0,
  events: 0,
  totalTokens: 0,
  requests: 0,
  turns: 0,
  steps: 0,
  toolCalls: 0,
  ttftSamples: 0,
  costHint: 0,
}
const foldStart = performance.now()
for (const artifact of artifacts) {
  const stats = emptySessionStats(artifact.header)
  foldEvents(stats, artifact.records)
  baseline.sessions += 1
  baseline.events += artifact.records.length
  baseline.totalTokens += sumTokens(stats)
  baseline.requests += stats.requests
  baseline.turns += stats.turns
  baseline.steps += stats.steps
  baseline.toolCalls += stats.toolCalls
  baseline.ttftSamples += stats.ttftSamples.length
}
const foldMs = performance.now() - foldStart

// ── ③ 假 sessionQuery（事件来自真实日志；live 会话用「最近仍有活动」的近似判定）──
let observeCalls = 0
function makeStubCtx(options = {}) {
  const liveIds =
    options.liveIds instanceof Set ? options.liveIds : new Set()
  const ctx = {
    sessionQuery: {
      async listSessions() {
        return artifacts.map((artifact) => ({
          header: { ...artifact.header },
          live: liveIds.has(artifact.header.id),
          persisted: true,
        }))
      },
      async observeSession(id) {
        observeCalls += 1
        const artifact = artifacts.find((entry) => entry.header.id === id)
        if (!artifact) throw new Error(`unknown session: ${id}`)
        return {
          source: 'prepared',
          header: { ...artifact.header },
          inheritedEventCount: 0,
          events: artifact.records, // 等价于真实 observeSession 的 frozen seed（无深拷贝）
          cursor: artifact.records.length > 0 ? artifact.records[artifact.records.length - 1].seq : -1,
          revision: `rev-${id}-${artifact.records.length}`,
          dispose() {},
        }
      },
    },
    webServer: { register: () => () => {} },
    on: () => () => {},
    logger: () => ({ warn() {}, debug() {}, error() {} }),
  }
  return ctx
}

/** 等后台扫描结束。 */
async function waitForScan(collector, expected, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const overview = await collector.getOverview({ range: 'all' })
    if (overview.scan && overview.scan.scanning === false && overview.scan.scanned >= expected) return overview
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return collector.getOverview({ range: 'all' })
}

/** 平均耗时（毫秒）。 */
async function timeAverageAsync(fn, count) {
  const start = performance.now()
  for (let index = 0; index < count; index += 1) await fn()
  return (performance.now() - start) / count
}

const report = {
  files: artifacts.length,
  decodeMs: Number(decodeMs.toFixed(1)),
  foldMs: Number(foldMs.toFixed(1)),
  baseline,
  collector: {},
  cacheRestart: {},
}

// ── ④ 第一次启动：冷扫全部会话 ──
rmSync(cacheDir, { recursive: true, force: true })
mkdirSync(cacheDir, { recursive: true })
const cacheFile = path.join(cacheDir, 'cache.json')

const stub = makeStubCtx()
const collector = createCollector(stub, { cacheFile, rescanIntervalMs: 60000 })
const scanStart = performance.now()
collector.start()
const scanSettled = await waitForScan(collector, artifacts.length)
const firstScanMs = performance.now() - scanStart
const overview24 = await collector.getOverview({ range: '24h', currency: 'USD' })
const overview7 = await collector.getOverview({ range: '7d', currency: 'CNY' })
const overviewAll = await collector.getOverview({ range: 'all', currency: 'USD' })
const getOverviewMs = await timeAverageAsync(() => collector.getOverview({ range: '24h' }), 20)
const getLiveMs = await timeAverageAsync(() => Promise.resolve(collector.getLive()), 20)
const live = collector.getLive()

report.collector = {
  observeCallsFirstRun: observeCalls,
  firstScanMs: Number(firstScanMs.toFixed(1)),
  coldScanEstimateMs: Number((decodeMs + firstScanMs).toFixed(1)),
  scanState: scanSettled.scan,
  getOverview24hAvgMs: Number(getOverviewMs.toFixed(3)),
  getLiveAvgMs: Number(getLiveMs.toFixed(3)),
  overviewAllKpi: {
    totalTokens: overviewAll.kpi.totalTokens,
    requests: overviewAll.kpi.requests,
    turns: overviewAll.kpi.turns,
    steps: overviewAll.kpi.steps,
    toolCalls: overviewAll.kpi.toolCalls,
    cacheHitRate: Number(overviewAll.kpi.cacheHitRate.toFixed(4)),
    costCNY: Number(overviewAll.kpi.costCNY.toFixed(6)),
    currency: overviewAll.kpi.currency,
  },
  overview7d: { sessions: overview7.kpi.sessions, cost: Number(overview7.kpi.cost.toFixed(6)), currency: overview7.kpi.currency, fxRate: overview7.kpi.fxRate },
  series: {
    '24h': { granularity: overview24.series.granularity, buckets: overview24.series.buckets.length },
    '7d': { granularity: overview7.series.granularity, buckets: overview7.series.buckets.length },
    all: { granularity: overviewAll.series.granularity, buckets: overviewAll.series.buckets.length },
  },
  sessions: overviewAll.sessions.length,
  sessions24h: overview24.sessions.length,
  models: overviewAll.models.map((model) => ({
    model: `${model.provider}/${model.model}`,
    requests: model.requests,
    totalTokens: model.totalTokens,
    costCNY: Number(model.costCNY.toFixed(6)),
    avgTtftMs: Number(model.avgTtftMs.toFixed(1)),
    tokensPerSec: Number(model.tokensPerSec.toFixed(2)),
    priced: model.priced,
  })),
  ttftSamples: overviewAll.performance.ttft.samples,
  avgTtftMs: Number(overviewAll.performance.ttft.avg.toFixed(1)),
  tokensPerSec: Number(overviewAll.performance.tokensPerSec.avg.toFixed(2)),
  toolShare: Number(overviewAll.performance.toolShare.toFixed(4)),
  live: {
    counters: live.counters,
    gpu: live.gpu,
    historyLengths: {
      cpu: live.history.cpu.length,
      gpu: live.history.gpu.length,
      mem: live.history.mem.length,
      tokensPerMin: live.history.tokensPerMin.length,
    },
  },
  consistency: {
    'totalTokens 与独立 fold 恒等': overviewAll.kpi.totalTokens === baseline.totalTokens,
    'requests 与独立 fold 恒等': overviewAll.kpi.requests === baseline.requests,
    'turns 与独立 fold 恒等': overviewAll.kpi.turns === baseline.turns,
    'steps 与独立 fold 恒等': overviewAll.kpi.steps === baseline.steps,
    'toolCalls 与独立 fold 恒等': overviewAll.kpi.toolCalls === baseline.toolCalls,
    'ttftSamples 与独立 fold 恒等': overviewAll.performance.ttft.samples === baseline.ttftSamples,
    'series 桶合计 = kpi.totalTokens': overview24.series.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0) === overview24.kpi.totalTokens,
  },
}

// 等 GPU 异步刷新一次（最多 2s；无 nvidia-smi 不算失败）
{
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const current = collector.getLive()
    if (current.gpu.available === true) {
      report.collector.live.gpuAfterRefresh = current.gpu
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

collector.dispose()
collector.dispose() // 幂等

// ── ⑤ 第二次启动：落盘缓存命中（不再冷读任何会话）──
const stub2 = makeStubCtx()
const observeBefore = observeCalls
const collector2 = createCollector(stub2, { cacheFile, rescanIntervalMs: 60000 })
const cacheStart = performance.now()
collector2.start()
// 缓存是同步读入的：start() 返回后立即取 overview 应当很快
// 用 range=all 与 baseline（全库独立 fold）对账 token 合计，避免 24h 裁剪造成误判。
const cachedOverview = await collector2.getOverview({ range: 'all' })
const cachedOverview24h = await collector2.getOverview({ range: '24h' })
const firstOverviewAfterCacheMs = performance.now() - cacheStart
const secondSettled = await waitForScan(collector2, artifacts.length)
const secondScanMs = performance.now() - cacheStart
report.cacheRestart = {
  observeCallsSecondRun: observeCalls - observeBefore,
  firstOverviewAfterCacheMs: Number(firstOverviewAfterCacheMs.toFixed(3)),
  scanSettledMs: Number(secondScanMs.toFixed(1)),
  cached: secondSettled.scan.cached,
  scanned: secondSettled.scan.scanned,
  totalTokens: cachedOverview.kpi.totalTokens,
  totalTokens24h: cachedOverview24h.kpi.totalTokens,
  scansInSecondRun: secondSettled.scan.scanned,
}
collector2.dispose()

// ── ⑥ 断言 ──
const failures = []
function expect(name, condition, detail) {
  if (!condition) failures.push(detail === undefined ? name : `${name}: ${detail}`)
}
expect('文件数 > 50', report.files > 50, String(report.files))
expect('冷扫（解码+扫描）< 8000ms', report.collector.coldScanEstimateMs < 8000, String(report.collector.coldScanEstimateMs))
expect('首扫扫描本身 < 3000ms', report.collector.firstScanMs < 3000, String(report.collector.firstScanMs))
expect('getOverview(24h) 平均 < 300ms', report.collector.getOverview24hAvgMs < 300, String(report.collector.getOverview24hAvgMs))
expect('getLive 平均 < 50ms', report.collector.getLiveAvgMs < 50, String(report.collector.getLiveAvgMs))
expect('24h 桶数 = 24', report.collector.series['24h'].buckets === 24)
expect('7d 桶数 = 7', report.collector.series['7d'].buckets === 7)
expect('all 桶数 <= 90', report.collector.series.all.buckets <= 90, String(report.collector.series.all.buckets))
expect('totalTokens 与独立 fold 恒等', report.collector.consistency['totalTokens 与独立 fold 恒等'])
expect('requests 与独立 fold 恒等', report.collector.consistency['requests 与独立 fold 恒等'])
expect('turns 与独立 fold 恒等', report.collector.consistency['turns 与独立 fold 恒等'])
expect('steps 与独立 fold 恒等', report.collector.consistency['steps 与独立 fold 恒等'])
expect('toolCalls 与独立 fold 恒等', report.collector.consistency['toolCalls 与独立 fold 恒等'])
expect('ttftSamples 与独立 fold 恒等', report.collector.consistency['ttftSamples 与独立 fold 恒等'])
expect('series 桶合计 = kpi.totalTokens', report.collector.consistency['series 桶合计 = kpi.totalTokens'])
expect('models 全部 priced', report.collector.models.every((model) => model.priced === true))
expect('cacheHitRate 在 0.9~1.0', report.collector.overviewAllKpi.cacheHitRate >= 0.9 && report.collector.overviewAllKpi.cacheHitRate <= 1)
expect('ttft 平均在 800~2500ms', report.collector.avgTtftMs > 800 && report.collector.avgTtftMs < 2500, String(report.collector.avgTtftMs))
expect('tokensPerSec 在 80~600', report.collector.tokensPerSec > 80 && report.collector.tokensPerSec < 600, String(report.collector.tokensPerSec))
expect('缓存重启后 0 次冷读', report.cacheRestart.observeCallsSecondRun === 0, String(report.cacheRestart.observeCallsSecondRun))
expect('缓存重启后首屏 < 300ms', report.cacheRestart.firstOverviewAfterCacheMs < 300, String(report.cacheRestart.firstOverviewAfterCacheMs))
expect('缓存重启后 totalTokens 不变', report.cacheRestart.totalTokens === baseline.totalTokens)
expect('history 长度 = 60', Object.values(report.collector.live.historyLengths).every((length) => length === 60))

rmSync(cacheDir, { recursive: true, force: true })

console.log(JSON.stringify(report, null, 2))
console.log(`\n集成自检：${failures.length === 0 ? '✓ 全部通过' : `✗ ${failures.length} 项失败`}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
