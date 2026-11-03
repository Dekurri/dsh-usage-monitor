/**
 * 离线真实数据自测：直接扫全库 session.v4.jsonl.zstd，用 lib/fold.js 的纯函数折叠，
 * 打印真实数字（会话数 / 事件数 / 耗时 / token 分桶 / ttft 样本 / 峰谷成本 / 前 5 会话）。
 *
 * 用法：
 *   node tools/scan-real.mjs
 *   node tools/scan-real.mjs --limit 20        # 只扫前 20 个会话（按路径排序）
 *   DSH_SESSIONS_ROOT=D:\\x node tools/scan-real.mjs
 *
 * 注意：本脚本只读会话日志，不写入任何文件。运行时 Host 走 ctx.sessionQuery，
 * 这里的 zstd 解码只是为了离线验证折叠口径（tools/zstd-frames.mjs 由 Lead 提供）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {
  BUILTIN_PRICING,
  cacheHitRateOf,
  costOf,
  emptySessionStats,
  foldEvents,
  priceFor,
  splitModelKey,
  sumTokens,
} from '../lib/fold.js'
import { readSessionArtifact } from './zstd-frames.mjs'

/** 默认真实日志根目录（可通过环境变量覆盖）。 */
const DEFAULT_ROOT = path.join(os.homedir(), '.dsh', 'sessions')
const SESSION_FILE = 'session.v4.jsonl.zstd'

/** @returns {string[]} 全库会话文件路径（按字典序，保证可复现）。 */
function findSessionFiles(root) {
  const found = []
  let entries
  try {
    entries = readdirSync(root, { recursive: true })
  } catch (error) {
    console.error(`无法读取日志根目录 ${root}: ${error instanceof Error ? error.message : error}`)
    return found
  }
  for (const entry of entries) {
    if (!String(entry).endsWith(SESSION_FILE)) continue
    const absolute = path.join(root, String(entry))
    try {
      if (statSync(absolute).isFile()) found.push(absolute)
    } catch {
      // 文件在扫描期间消失：忽略
    }
  }
  found.sort()
  return found
}

/** 解析 --limit N。 */
function parseLimit(argv) {
  const index = argv.indexOf('--limit')
  if (index < 0) return Number.POSITIVE_INFINITY
  const value = Number.parseInt(argv[index + 1] ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY
}

/** 本地时区今日 00:00 的 epoch ms（用于「今日成本」按事件时间归属）。 */
const localMidnight = (() => {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
})()

const sessionsRoot = process.env.DSH_SESSIONS_ROOT || DEFAULT_ROOT
const limit = parseLimit(process.argv.slice(2))
const files = findSessionFiles(sessionsRoot).slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit)
if (files.length === 0) {
  console.error(`在 ${sessionsRoot} 下没有找到 ${SESSION_FILE}`)
  process.exit(1)
}

const aggregate = {
  files: 0,
  emptySessions: 0,
  events: 0,
  frames: 0,
  torn: 0,
  bytesIn: 0,
  decompressMs: 0,
  parseMs: 0,
  foldMs: 0,
  tokens: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  requests: 0,
  turns: 0,
  steps: 0,
  toolCalls: 0,
  errorTurns: 0,
  interruptedTurns: 0,
  ttftSamples: 0,
  tpsSamples: 0,
  ttftMs: 0,
  ttftCount: 0,
  decodeMs: 0,
  decodeTokens: 0,
  llmMs: 0,
  toolMs: 0,
  // v3 峰谷成本（fold 按事件时间算好，逐条累加）
  costCNY: 0,
  // v1/v2 旧口径：所有 token 都按 peak CNY 价（用于展示「改前 vs 改后」）
  costCNYAllPeak: 0,
  // 本地今日 00:00 起的成本（CNY），来自各会话的小时桶
  todayCostCNY: 0,
  pricedSessions: 0,
  unpricedModels: new Set(),
  models: new Map(),
  earliest: null,
  latest: null,
  hourBuckets: 0,
  parseErrors: 0,
}

const perSession = []
const overallStart = performance.now()

for (const file of files) {
  const bytes = readFileSync(file)
  aggregate.files += 1
  aggregate.bytesIn += bytes.length

  // ① zstd 多帧解码 + 逐行 JSON.parse（tools/zstd-frames.mjs 已按帧解压）
  const decompressStart = performance.now()
  let artifact
  try {
    artifact = readSessionArtifact(bytes)
  } catch (error) {
    aggregate.parseErrors += 1
    console.error(`解析失败 ${path.basename(path.dirname(file))}: ${error instanceof Error ? error.message : error}`)
    continue
  }
  aggregate.decompressMs += performance.now() - decompressStart
  aggregate.frames += artifact.frames
  if (artifact.torn) aggregate.torn += 1

  // ② 纯函数折叠（运行时 Host 也走这一条路径，只是事件来自 ctx.sessionQuery）
  const header = artifact.header ?? {}
  const stats = emptySessionStats(header)
  const foldStart = performance.now()
  foldEvents(stats, artifact.records)
  aggregate.foldMs += performance.now() - foldStart
  aggregate.events += artifact.records.length
  if (artifact.records.length === 0) aggregate.emptySessions += 1

  // ③ 汇总
  for (const field of Object.keys(aggregate.tokens)) aggregate.tokens[field] += stats[field]
  aggregate.requests += stats.requests
  aggregate.turns += stats.turns
  aggregate.steps += stats.steps
  aggregate.toolCalls += stats.toolCalls
  aggregate.errorTurns += stats.errorTurns
  aggregate.interruptedTurns += stats.interruptedTurns
  aggregate.ttftSamples += stats.ttftSamples.length
  aggregate.tpsSamples += stats.tpsSamples.length
  aggregate.ttftMs += stats.ttftMs
  aggregate.ttftCount += stats.ttftCount
  aggregate.decodeMs += stats.decodeMs
  aggregate.decodeTokens += stats.decodeTokens
  aggregate.llmMs += stats.llmMs
  aggregate.toolMs += stats.toolMs
  aggregate.hourBuckets += stats.hours.size
  if (stats.firstEventAt !== null) {
    aggregate.earliest = aggregate.earliest === null ? stats.firstEventAt : Math.min(aggregate.earliest, stats.firstEventAt)
  }
  if (stats.lastActivityAt !== null) {
    aggregate.latest = aggregate.latest === null ? stats.lastActivityAt : Math.max(aggregate.latest, stats.lastActivityAt)
  }

  // ④ 成本（v3）：fold 已按每条 usage 的事件时间把峰谷成本写进 stats.costCNY 与小时桶；
  // 这里同时算「全部按 peak CNY 价」的旧口径（v1/v2），用于对比 off-peak 高估了多少。
  let sessionCostUSDAllPeak = 0
  let sessionPriced = false
  for (const [modelKey, modelStats] of stats.models) {
    const { provider, model } = splitModelKey(modelKey)
    const peakPrice = priceFor(model, BUILTIN_PRICING) // 第三参缺省 = peak，即旧口径
    const allPeakCost = costOf(modelStats, peakPrice)
    sessionCostUSDAllPeak += allPeakCost
    if (peakPrice !== null) sessionPriced = true
    else aggregate.unpricedModels.add(`${provider}/${model}`)
    let total = aggregate.models.get(modelKey)
    if (!total) {
      total = {
        provider,
        model,
        requests: 0,
        ...{ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        costCNY: 0,
        costCNYAllPeak: 0,
        priced: peakPrice !== null,
      }
      aggregate.models.set(modelKey, total)
    }
    total.requests += modelStats.requests
    for (const field of Object.keys(aggregate.tokens)) total[field] += modelStats[field]
    // fold 在 modelStats.costCNY 里按事件时间累计了峰谷成本
    total.costCNY += modelStats.costCNY ?? 0
    total.costCNYAllPeak += allPeakCost
  }
  aggregate.costCNY += stats.costCNY ?? 0
  aggregate.costCNYAllPeak += sessionCostUSDAllPeak
  // 今日（本地 00:00 起）：按小时桶的事件时间归属，桶成本已是峰谷口径
  for (const [hourStart, bucket] of stats.hours) {
    if (hourStart >= localMidnight) aggregate.todayCostCNY += bucket.costCNY ?? 0
  }
  if (sessionPriced) aggregate.pricedSessions += 1

  perSession.push({
    file: path.relative(sessionsRoot, file),
    id: stats.id,
    createdAt: stats.createdAt,
    lastActivityAt: stats.lastActivityAt,
    events: stats.eventCount,
    totalTokens: sumTokens(stats),
    tokens: {
      uncachedInputTokens: stats.uncachedInputTokens,
      cacheReadTokens: stats.cacheReadTokens,
      cacheWriteTokens: stats.cacheWriteTokens,
      outputTokens: stats.outputTokens,
      reasoningTokens: stats.reasoningTokens,
    },
    cacheHitRate: Number(cacheHitRateOf(stats).toFixed(4)),
    requests: stats.requests,
    turns: stats.turns,
    steps: stats.steps,
    toolCalls: stats.toolCalls,
    ttftSamples: stats.ttftSamples.length,
    avgTtftMs: stats.ttftCount > 0 ? Number((stats.ttftMs / stats.ttftCount).toFixed(1)) : 0,
    tokensPerSec:
      stats.decodeMs > 0 ? Number((stats.decodeTokens / (stats.decodeMs / 1000)).toFixed(2)) : 0,
    toolMs: Math.round(stats.toolMs),
    llmMs: Math.round(stats.llmMs),
    hourBuckets: stats.hours.size,
    models: [...stats.models.values()].map((m) => `${m.provider}/${m.model}`),
    costCNY: Number((stats.costCNY ?? 0).toFixed(6)),
    costCNYAllPeak: Number(sessionCostUSDAllPeak.toFixed(6)),
  })
}

const totalMs = performance.now() - overallStart
const totalTokens = sumTokens(aggregate.tokens)
const hitRate = cacheHitRateOf(aggregate.tokens)
const chatModels = [...aggregate.models.values()]
  .sort((left, right) => sumTokens(right) - sumTokens(left))
  .map((model) => ({
    model: `${model.provider}/${model.model}`,
    requests: model.requests,
    totalTokens: sumTokens(model),
    cacheReadTokens: model.cacheReadTokens,
    outputTokens: model.outputTokens,
    costCNY: Number(model.costCNY.toFixed(6)),
    costCNYAllPeak: Number(model.costCNYAllPeak.toFixed(6)),
    priced: model.priced,
  }))
const topSessions = [...perSession].sort((left, right) => right.totalTokens - left.totalTokens).slice(0, 5)

const report = {
  root: sessionsRoot,
  files: aggregate.files,
  emptySessions: aggregate.emptySessions,
  zstdFrames: aggregate.frames,
  tornTail: aggregate.torn,
  events: aggregate.events,
  parseErrors: aggregate.parseErrors,
  bytesIn: aggregate.bytesIn,
  timingsMs: {
    total: Number(totalMs.toFixed(1)),
    decompressAndParse: Number(aggregate.decompressMs.toFixed(1)),
    foldOnly: Number(aggregate.foldMs.toFixed(1)),
    avgPerSession: Number((totalMs / Math.max(1, aggregate.files)).toFixed(2)),
    avgFoldPerSession: Number((aggregate.foldMs / Math.max(1, aggregate.files)).toFixed(2)),
  },
  tokens: { ...aggregate.tokens, totalTokens },
  cacheHitRate: Number(hitRate.toFixed(4)),
  requests: aggregate.requests,
  turns: aggregate.turns,
  steps: aggregate.steps,
  toolCalls: aggregate.toolCalls,
  errorTurns: aggregate.errorTurns,
  interruptedTurns: aggregate.interruptedTurns,
  ttftSamples: aggregate.ttftSamples,
  tpsSamples: aggregate.tpsSamples,
  avgTtftMs: aggregate.ttftCount > 0 ? Number((aggregate.ttftMs / aggregate.ttftCount).toFixed(1)) : 0,
  tokensPerSec:
    aggregate.decodeMs > 0 ? Number((aggregate.decodeTokens / (aggregate.decodeMs / 1000)).toFixed(2)) : 0,
  toolShare:
    aggregate.llmMs + aggregate.toolMs > 0
      ? Number((aggregate.toolMs / (aggregate.llmMs + aggregate.toolMs)).toFixed(4))
      : 0,
  llmMs: Math.round(aggregate.llmMs),
  toolMs: Math.round(aggregate.toolMs),
  hourBuckets: aggregate.hourBuckets,
  activityWindow: {
    earliest: aggregate.earliest === null ? null : new Date(aggregate.earliest).toISOString(),
    latest: aggregate.latest === null ? null : new Date(aggregate.latest).toISOString(),
  },
  pricing: {
    source: 'builtin: official CNY list price (api-docs.deepseek.com); peak/off-peak, off-peak = half of peak; weekends & Chinese public holidays = off-peak all day',
    costCNY: Number(aggregate.costCNY.toFixed(6)),
    costCNYAllPeak: Number(aggregate.costCNYAllPeak.toFixed(6)),
    offPeakSavingCNY: Number((aggregate.costCNYAllPeak - aggregate.costCNY).toFixed(6)),
    todayCostCNY: Number(aggregate.todayCostCNY.toFixed(6)),
    pricedSessions: aggregate.pricedSessions,
    unpricedModels: [...aggregate.unpricedModels],
  },
  models: chatModels,
  top5Sessions: topSessions,
}

console.log(JSON.stringify(report, null, 2))

// 终端友好摘要（便于贴进报告 / 与 oracle 对账）
console.log('\n── 摘要 ──')
console.log(
  `会话 ${report.files} / 事件 ${report.events} / 帧 ${report.zstdFrames} / 输入 ${(report.bytesIn / 1024 / 1024).toFixed(1)}MB`,
)
console.log(
  `耗时 总 ${report.timingsMs.total}ms（解码+解析 ${report.timingsMs.decompressAndParse}ms，折叠 ${report.timingsMs.foldOnly}ms）`,
)
console.log(`totalTokens ${report.tokens.totalTokens}  cacheHitRate ${report.cacheHitRate}`)
console.log(
  `turns ${report.turns} / steps ${report.steps} / requests ${report.requests} / toolCalls ${report.toolCalls}`,
)
console.log(
  `avgTtftMs ${report.avgTtftMs} / tokensPerSec ${report.tokensPerSec} / toolShare ${report.toolShare}`,
)
console.log(
  `成本 v3(峰谷) ¥${report.pricing.costCNY} ｜ 改前(全按 peak) ¥${report.pricing.costCNYAllPeak} ｜ off-peak 少算 ¥${report.pricing.offPeakSavingCNY}`,
)
console.log(
  `今日(本地 00:00 起)成本 ¥${report.pricing.todayCostCNY}`,
)
