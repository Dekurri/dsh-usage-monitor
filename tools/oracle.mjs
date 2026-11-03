/**
 * Independent oracle: re-fold every persisted session log straight from disk
 * with no Host service in the loop, so the plugin's collector can be diffed
 * against a second implementation.
 *
 * The token fold deliberately mirrors the Host's authoritative
 * `dsh-token-meter` `tokenUsage` projection (retry replacement semantics), and
 * the step/turn counters deliberately mirror `dsh-session-stats`
 * (`step/end` is the counting authority). Anything that disagrees with those
 * two sources is a bug on our side, not a difference of opinion.
 *
 *   node tools/oracle.mjs [--json] [--sessions] [--range 24h|7d|14d|30d|all]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readSessionArtifact } from './zstd-frames.mjs'
import { CN_HOLIDAY_DAYS } from '../lib/fold.js'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')

const RANGES = {
  '24h': 24 * 3600_000,
  '7d': 7 * 86400_000,
  '14d': 14 * 86400_000,
  '30d': 30 * 86400_000,
  all: Infinity,
}

/** One token bucket, zeroed. */
const zeroBuckets = () => ({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })

/** Map a provider usage sample onto our four buckets. */
function bucketsFromUsage(usage) {
  return {
    uncachedInputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
  }
}

/** Structural equality of two buckets. */
function bucketsEqual(left, right) {
  return (
    left.uncachedInputTokens === right.uncachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens
  )
}

/** Add `next` and subtract `previous` — the projection's replacement fold. */
function bucketsDelta(previous, next) {
  return {
    uncachedInputTokens: next.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0),
    outputTokens: next.outputTokens - (previous?.outputTokens ?? 0),
    cacheReadTokens: next.cacheReadTokens - (previous?.cacheReadTokens ?? 0),
    cacheWriteTokens: next.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0),
  }
}

/** Apply a signed delta to a bucket set in place. */
function applyDelta(target, delta) {
  target.uncachedInputTokens += delta.uncachedInputTokens
  target.outputTokens += delta.outputTokens
  target.cacheReadTokens += delta.cacheReadTokens
  target.cacheWriteTokens += delta.cacheWriteTokens
}

/** The last `usage` chunk inside an assistant stream, if any. */
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const chunk = stream[index]?.chunk
    if (chunk && chunk.type === 'usage' && chunk.usage) return chunk.usage
  }
  return undefined
}

/**
 * The usage one durable assistant settlement reports, per `dsh-token-meter`'s
 * `usageOf`: a message's own `data.usage` wins; otherwise the last usage chunk
 * of its stream is used, and attempts participate too.
 */
function usageOf(event) {
  const data = event.data ?? {}
  if (event.type === 'assistant/message' && data.usage !== undefined) return data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastStreamUsage(data.stream)
}

/** @returns {string[]} every `session.v4.jsonl.zstd` path under the sessions root. */

// ---------------------------------------------------------------------------
// v3 峰谷定价（与 lib/fold.js 同口径，独立实现，供差分对账用）
// v5 官方人民币价表 + 中国法定节假日（独立实现，只 import 节假日数据，不 import 判定函数）。
// peak = 北京时间工作日 9:00-12:00 / 14:00-18:00 = UTC 01:00-04:00 / 06:00-10:00；
// 周末与中国法定节假日全天 off-peak（价格为 peak 的一半）。
// ---------------------------------------------------------------------------
// CNY / 1M tokens（官方人民币价；CNY 是权威基准，与 lib/fold.js 一致）。
const PEAK_PRICES = {
  'deepseek-flash': [2, 0.04, 2, 8],
  'deepseek-v4-flash': [2, 0.04, 2, 8],
  'deepseek-v4-flash-vision-exp': [2, 0.04, 2, 8],
  'deepseek-v4-pro': [9, 0.3, 9, 27],
  'deepseek-chat': [1.988, 0.1988, 1.988, 2.982],
  'deepseek-reasoner': [1.988, 0.1988, 1.988, 2.982],
}

const HOLIDAY_SET = new Set(CN_HOLIDAY_DAYS)

/** 北京日历日键（UTC+8，固定偏移）。 */
function beijingDayKey(timeMs) {
  const date = new Date(timeMs + 8 * 3_600_000)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return date.getUTCFullYear() + '-' + month + '-' + day
}

function isPeakHour(timeMs) {
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return true
  if (HOLIDAY_SET.has(beijingDayKey(timeMs))) return false // 中国法定节假日全天谷价
  const date = new Date(timeMs)
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

function costOfBuckets(buckets, model, timeMs) {
  if (typeof model !== 'string' || model.length === 0) return 0
  const name = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model
  const peak = PEAK_PRICES[name]
  if (!peak) return 0
  const factor = isPeakHour(timeMs) ? 1 : 0.5
  const units =
    (buckets.uncachedInputTokens ?? 0) * peak[0] * factor +
    (buckets.cacheReadTokens ?? 0) * peak[1] * factor +
    (buckets.cacheWriteTokens ?? 0) * peak[2] * factor +
    (buckets.outputTokens ?? 0) * peak[3] * factor
  return Number.isFinite(units) ? units / 1e6 : 0
}
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

/**
 * Derive TTFT and decode window from one assistant stream.
 *
 * The stream is a flat array: `{type:'chunk', time, chunk}` for block
 * boundaries / usage / finish, and `{type:'text-chunks'|'reasoning-chunks'|
 * 'tool-call-chunks', time0, index, dt, texts}` for the token groups. The first
 * group with content marks the first token; `dt` holds inter-token gaps.
 */
function measureStream(stream, completedAt, requestStart) {
  if (!Array.isArray(stream) || stream.length === 0) return { ttftMs: null, decodeMs: null }
  let firstTokenAt = null
  for (const entry of stream) {
    const texts = entry?.texts
    const hasContent = Array.isArray(texts) && texts.some((piece) => typeof piece === 'string' && piece.length > 0)
    if (!hasContent) continue
    if (typeof entry.time0 === 'number') firstTokenAt = entry.time0
    break
  }
  if (firstTokenAt === null) return { ttftMs: null, decodeMs: null }
  const base = typeof requestStart === 'number' ? requestStart : firstTokenAt
  return {
    ttftMs: Math.max(0, firstTokenAt - base),
    decodeMs: typeof completedAt === 'number' ? Math.max(0, completedAt - firstTokenAt) : null,
  }
}

/** Fold one artifact into per-session counters. */
function foldSession(path) {
  const buffer = readFileSync(path)
  const { header, records } = readSessionArtifact(buffer)
  const stat = statSync(path)
  const tokens = zeroBuckets()
  const stats = {
    id: header?.id ?? path,
    cwd: header?.cwd ?? null,
    createdAt: header?.createdAt ?? 0,
    agentPreset: header?.agentPreset ?? null,
    origin: header?.origin ?? null,
    parentSession: header?.parentSession ?? null,
    delegationDepth: header?.delegationDepth ?? 0,
    title: null,
    lastActivityAt: header?.createdAt ?? stat.mtimeMs,
    // `dsh-session-stats`口径: turn/step counted on step/end.
    turns: 0,
    lastTurn: null,
    steps: 0,
    requests: 0,
    toolCalls: 0,
    errorTurns: 0,
    interruptedTurns: 0,
    reasoningTokens: 0,
    ttftSum: 0,
    ttftCount: 0,
    decodeMs: 0,
    decodeTokens: 0,
    llmMs: 0,
    toolMs: 0,
    ...tokens,
    get totalTokens() {
      return this.uncachedInputTokens + this.cacheReadTokens + this.cacheWriteTokens + this.outputTokens
    },
    models: new Map(),
    /** Replacement slot of the tokenUsage projection. */
    last: null,
    /** v3 峰谷定价：按事件时间累计的 USD 成本。 */
    costCNY: 0,
    /** 最近一条 assistant/message 的模型（assistant/attempt 的成本归属）。 */
    lastModel: null,
  }

  /** @type {Map<string, number>} `${turn}:${step}` -> step/start time, for llm wall clock. */
  const stepStart = new Map()
  /** @type {Map<string, number>} callId -> tool/call time. */
  const toolStart = new Map()

  for (const record of records) {
    const data = record.data ?? {}
    if (typeof record.time === 'number' && record.time > stats.lastActivityAt) {
      stats.lastActivityAt = record.time
    }
    switch (record.type) {
      case 'turn/end': {
        const kind = data.reason?.kind ?? data.reason
        if (kind === 'error' || kind === 'blocked' || kind === 'max-tokens') stats.errorTurns += 1
        else if (kind === 'interrupted' || kind === 'aborted') stats.interruptedTurns += 1
        break
      }
      case 'step/start':
        stepStart.set(`${data.turn}:${data.step}`, record.time)
        break
      case 'step/end': {
        if (stats.lastTurn !== data.turn) {
          stats.turns += 1
          stats.lastTurn = data.turn
        }
        stats.steps += 1
        stepStart.delete(`${data.turn}:${data.step}`)
        break
      }
      case 'tool/call':
        stats.toolCalls += 1
        toolStart.set(data.callId, record.time)
        break
      case 'tool/result': {
        // `tool/result` carries no callId of its own; the pairing key lives on
        // the tool message (`data.message.toolCallId`, mirrored in `source.callId`).
        const callId = data.message?.toolCallId ?? data.message?.source?.callId
        const started = toolStart.get(callId)
        if (typeof started === 'number' && typeof record.time === 'number') {
          stats.toolMs += Math.max(0, record.time - started)
        }
        toolStart.delete(callId)
        break
      }
      case 'session/title':
        if (typeof data.title === 'string') stats.title = data.title
        break
      case 'llm/retry-started':
        // A retry only clears the replacement slot when it retries that slot's step.
        if (stats.last && stats.last.turn === data.turn && stats.last.step === data.step) stats.last = null
        break
      case 'assistant/message':
      case 'assistant/attempt': {
        const source = data.message?.source
        const modelKey = source && source.kind === 'model' ? `${source.provider}/${source.model}` : null
        const started = stepStart.get(`${data.turn}:${data.step}`)
        const sample = usageOf(record)
        if (record.type === 'assistant/message') {
          stats.requests += 1
          if (typeof started === 'number' && typeof record.time === 'number') {
            stats.llmMs += Math.max(0, record.time - started)
          }
          const measured = measureStream(data.stream, record.time, started)
          if (measured.ttftMs !== null) {
            stats.ttftSum += measured.ttftMs
            stats.ttftCount += 1
          }
          if (measured.decodeMs !== null && sample) {
            stats.decodeMs += measured.decodeMs
            stats.decodeTokens += sample.outputTokens ?? 0
          }
        }
        if (!sample) break
        const buckets = bucketsFromUsage(sample)
        const previous = stats.last && stats.last.turn === data.turn && stats.last.step === data.step ? stats.last.buckets : null
        if (previous && bucketsEqual(previous, buckets)) break
        const delta = bucketsDelta(previous, buckets)
        applyDelta(stats, delta)
        // v3 峰谷定价：模型归属 —— assistant/message 用自身 message.source.model；
        // assistant/attempt（Auto review 等）沿用上一条 message 的模型。
        const messageModel = source && source.kind === 'model' && typeof source.model === 'string' ? source.model : null
        const costModel = record.type === 'assistant/message' ? messageModel : stats.lastModel
        const cost = costOfBuckets(buckets, costModel ?? '', record.time)
        if (previous && typeof stats.last.cost === 'number') stats.costCNY -= stats.last.cost
        stats.costCNY += cost
        stats.reasoningTokens += (sample.reasoningTokens ?? 0) - (previous?.reasoningTokens ?? 0)
        if (modelKey) {
          let bucket = stats.models.get(modelKey)
          if (!bucket) {
            bucket = { requests: 0, ...zeroBuckets(), reasoningTokens: 0 }
            stats.models.set(modelKey, bucket)
          }
          if (record.type === 'assistant/message') bucket.requests += 1
          applyDelta(bucket, delta)
          bucket.reasoningTokens += (sample.reasoningTokens ?? 0) - (previous?.reasoningTokens ?? 0)
        }
        if (record.type === 'assistant/message') stats.lastModel = messageModel
        stats.last = {
          turn: data.turn,
          step: data.step,
          buckets: { ...buckets, reasoningTokens: sample.reasoningTokens ?? 0 },
          cost,
        }
        break
      }
      default:
        break
    }
  }

  const inputTotal = stats.uncachedInputTokens + stats.cacheReadTokens + stats.cacheWriteTokens
  stats.cacheHitRate = inputTotal > 0 ? stats.cacheReadTokens / inputTotal : 0
  stats.avgTtftMs = stats.ttftCount > 0 ? stats.ttftSum / stats.ttftCount : 0
  stats.tokensPerSec = stats.decodeMs > 0 ? (stats.decodeTokens / stats.decodeMs) * 1000 : 0
  return stats
}

function main() {
  const args = process.argv.slice(2)
  const wantJson = args.includes('--json')
  const wantSessions = args.includes('--sessions')
  const rangeIndex = args.indexOf('--range')
  const rangeKey = rangeIndex >= 0 ? args[rangeIndex + 1] : 'all'
  const windowMs = RANGES[rangeKey] ?? Infinity
  const to = Date.now()
  const from = windowMs === Infinity ? -Infinity : to - windowMs

  const startedAt = process.hrtime.bigint()
  const paths = listArtifacts()
  const sessions = []
  let failures = 0
  for (const path of paths) {
    try {
      sessions.push(foldSession(path))
    } catch (error) {
      failures += 1
      console.error('[oracle] failed', path, error instanceof Error ? error.message : error)
    }
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

  const inRange = windowMs === Infinity ? sessions : sessions.filter((s) => s.lastActivityAt >= from && s.lastActivityAt <= to)
  const agg = {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    turns: 0,
    steps: 0,
    requests: 0,
    toolCalls: 0,
    errorTurns: 0,
    interruptedTurns: 0,
    ttftSum: 0,
    ttftCount: 0,
    decodeMs: 0,
    decodeTokens: 0,
    llmMs: 0,
    toolMs: 0,
    costCNY: 0,
  }
  const modelTotals = new Map()
  for (const session of inRange) {
    for (const key of Object.keys(agg)) agg[key] += session[key] ?? 0
    for (const [model, bucket] of session.models) {
      let target = modelTotals.get(model)
      if (!target) {
        target = { requests: 0, ...zeroBuckets(), reasoningTokens: 0 }
        modelTotals.set(model, target)
      }
      for (const key of Object.keys(target)) target[key] += bucket[key] ?? 0
    }
  }
  const totalTokens = agg.uncachedInputTokens + agg.cacheReadTokens + agg.cacheWriteTokens + agg.outputTokens
  const inputTotal = agg.uncachedInputTokens + agg.cacheReadTokens + agg.cacheWriteTokens
  const summary = {
    range: rangeKey,
    sessionsTotal: sessions.length,
    sessionsInRange: inRange.length,
    failures,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    totalTokens,
    uncachedInputTokens: agg.uncachedInputTokens,
    cacheReadTokens: agg.cacheReadTokens,
    cacheWriteTokens: agg.cacheWriteTokens,
    outputTokens: agg.outputTokens,
    reasoningTokens: agg.reasoningTokens,
    cacheHitRate: inputTotal > 0 ? agg.cacheReadTokens / inputTotal : 0,
    turns: agg.turns,
    steps: agg.steps,
    requests: agg.requests,
    toolCalls: agg.toolCalls,
    errorTurns: agg.errorTurns,
    interruptedTurns: agg.interruptedTurns,
    avgTtftMs: agg.ttftCount > 0 ? agg.ttftSum / agg.ttftCount : 0,
    tokensPerSec: agg.decodeMs > 0 ? (agg.decodeTokens / agg.decodeMs) * 1000 : 0,
    toolShare: agg.llmMs + agg.toolMs > 0 ? agg.toolMs / (agg.llmMs + agg.toolMs) : 0,
    costCNY: agg.costCNY,
    models: [...modelTotals.entries()]
      .map(([model, bucket]) => ({
        model,
        requests: bucket.requests,
        totalTokens: bucket.uncachedInputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens + bucket.outputTokens,
        ...bucket,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
  }

  if (wantSessions) {
    summary.sessionList = inRange
      .slice()
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt,
        turns: s.turns,
        steps: s.steps,
        requests: s.requests,
        totalTokens: s.totalTokens,
        cacheReadTokens: s.cacheReadTokens,
        uncachedInputTokens: s.uncachedInputTokens,
        cacheHitRate: s.cacheHitRate,
        tokensPerSec: s.tokensPerSec,
      }))
  }

  if (wantJson) {
    console.log(JSON.stringify(summary, null, 2))
    return
  }
  const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : n)
  console.log(`range=${summary.range}  artifacts=${summary.sessionsTotal}  inRange=${summary.sessionsInRange}  failures=${summary.failures}  elapsed=${summary.elapsedMs}ms`)
  console.log(`totalTokens=${fmt(summary.totalTokens)}  (uncachedInput=${fmt(summary.uncachedInputTokens)} + cacheRead=${fmt(summary.cacheReadTokens)} + cacheWrite=${fmt(summary.cacheWriteTokens)} + output=${fmt(summary.outputTokens)})`)
  console.log(`cacheHitRate=${(summary.cacheHitRate * 100).toFixed(2)}%  turns=${fmt(summary.turns)}  steps=${fmt(summary.steps)}  requests=${fmt(summary.requests)}  toolCalls=${fmt(summary.toolCalls)}`)
  console.log(`avgTtftMs=${summary.avgTtftMs.toFixed(0)}  tokensPerSec=${summary.tokensPerSec.toFixed(1)}  toolShare=${(summary.toolShare * 100).toFixed(1)}%`)
  console.log(`costCNY(peak/off-peak)=${summary.costCNY.toFixed(6)}`)
  console.log('models:')
  for (const model of summary.models) console.log(`  ${model.model}  requests=${fmt(model.requests)}  totalTokens=${fmt(model.totalTokens)}  output=${fmt(model.outputTokens)}`)
  if (summary.sessionList) {
    console.log('top sessions:')
    for (const session of summary.sessionList.slice(0, 10)) {
      console.log(`  ${String(session.title ?? session.id).slice(0, 40).padEnd(40)} tokens=${fmt(session.totalTokens)}  cacheHit=${(session.cacheHitRate * 100).toFixed(1)}%  tps=${session.tokensPerSec.toFixed(1)}`)
    }
  }
}

main()
