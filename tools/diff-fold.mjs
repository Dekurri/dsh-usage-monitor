/**
 * Differential fold check: run `lib/fold.js` and this repo's independent
 * reference over the *same in-memory event arrays* and diff per-session
 * counters.
 *
 * Comparing two collectors that each re-read disk lets log growth masquerade as
 * a folding bug; pinning both to one snapshot removes that noise, so any
 * mismatch here is a real口径 difference.
 *
 * The reference is written from two authoritative sources and deliberately
 * imports nothing from `lib/`:
 *   - token buckets + retry replacement: `dsh-token-meter` `tokenUsage` projection
 *   - turn/step counts: `dsh-session-stats` (`step/end` is the authority)
 *
 *   node tools/diff-fold.mjs [--verbose] [--limit N]
 */

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as fold from '../lib/fold.js'
import { readSessionArtifact } from './zstd-frames.mjs'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const verbose = process.argv.includes('--verbose')
const limitIndex = process.argv.indexOf('--limit')
const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : Infinity

const failures = []

// ---------------------------------------------------------------------------
// v5 官方人民币价表 + 中国法定节假日（与 lib/fold.js 同口径，独立实现，供差分对账用）
// 价表数据照抄官方中文定价页的人民币价；节假日数据只 import CN_HOLIDAY_DAYS，
// 判定逻辑自己写（不调用 lib/fold.js 的 isPeakHour，避免同源验证）。
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

const HOLIDAY_SET = new Set(fold.CN_HOLIDAY_DAYS)

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


/** Walk the sessions root for persisted artifacts. */
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

/** Last `usage` chunk of an assistant stream. */
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const chunk = stream[index]?.chunk
    if (chunk && chunk.type === 'usage' && chunk.usage) return chunk.usage
  }
  return undefined
}

/** `dsh-token-meter`'s `usageOf`. */
function usageOf(event) {
  const data = event.data ?? {}
  if (event.type === 'assistant/message' && data.usage !== undefined) return data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastStreamUsage(data.stream)
}

/**
 * Independent reference fold, written directly from the observed log format and
 * the two authoritative projections. Deliberately does not import `lib/`.
 */
function referenceFold(header, records) {
  const out = {
    turns: 0,
    steps: 0,
    requests: 0,
    toolCalls: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    // v3: 每次采样按事件时间的峰谷价累加 USD（替换采样先撤回旧成本）
    costCNY: 0,
  }
  let toolMs = 0
  let llmMs = 0
  let lastTurn = null
  let lastModel = null
  /** @type {{turn: number, step: number, buckets: object} | null} */
  let slot = null
  /** @type {Map<string, number>} `${turn}:${step}` -> step/start time */
  const stepStart = new Map()
  /** @type {Map<string, number>} callId -> tool/call time */
  const toolStart = new Map()
  for (const record of records) {
    const data = record.data ?? {}
    const key = `${data.turn}:${data.step}`
    switch (record.type) {
      case 'step/start':
        stepStart.set(key, record.time)
        break
      case 'step/end':
        if (lastTurn !== data.turn) {
          out.turns += 1
          lastTurn = data.turn
        }
        out.steps += 1
        stepStart.delete(key)
        break
      case 'tool/call':
        out.toolCalls += 1
        toolStart.set(data.callId, record.time)
        break
      case 'tool/result': {
        const callId = data.message?.toolCallId ?? data.message?.source?.callId
        const started = toolStart.get(callId)
        if (typeof started === 'number') toolMs += Math.max(0, record.time - started)
        toolStart.delete(callId)
        break
      }
      case 'llm/retry-started':
        if (slot && slot.turn === data.turn && slot.step === data.step) slot = null
        break
      case 'assistant/message':
      case 'assistant/attempt': {
        if (record.type === 'assistant/message') {
          out.requests += 1
          const started = stepStart.get(key)
          if (typeof started === 'number') llmMs += Math.max(0, record.time - started)
        }
        const sample = usageOf(record)
        if (!sample) break
        const buckets = {
          uncachedInputTokens: sample.inputTokens ?? 0,
          outputTokens: sample.outputTokens ?? 0,
          cacheReadTokens: sample.cacheReadTokens ?? 0,
          cacheWriteTokens: sample.cacheWriteTokens ?? 0,
        }
        const previous = slot && slot.turn === data.turn && slot.step === data.step ? slot.buckets : null
        const same =
          previous &&
          previous.uncachedInputTokens === buckets.uncachedInputTokens &&
          previous.outputTokens === buckets.outputTokens &&
          previous.cacheReadTokens === buckets.cacheReadTokens &&
          previous.cacheWriteTokens === buckets.cacheWriteTokens
        if (same) break
        // v3 峰谷定价：模型归属 —— assistant/message 用自身 message.source.model；
        // assistant/attempt（Auto review 等）沿用上一条 message 的模型。
        const source = data.message?.source
        const messageModel = source && source.kind === 'model' && typeof source.model === 'string' ? source.model : null
        const costModel = record.type === 'assistant/message' ? messageModel : lastModel
        const cost = costOfBuckets(buckets, costModel ?? '', record.time)
        if (previous) out.costCNY -= slot.cost
        out.costCNY += cost
        out.uncachedInputTokens += buckets.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0)
        out.outputTokens += buckets.outputTokens - (previous?.outputTokens ?? 0)
        out.cacheReadTokens += buckets.cacheReadTokens - (previous?.cacheReadTokens ?? 0)
        out.cacheWriteTokens += buckets.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0)
        out.reasoningTokens += (sample.reasoningTokens ?? 0) - (previous?.reasoningTokens ?? 0)
        slot = { turn: data.turn, step: data.step, buckets: { ...buckets, reasoningTokens: sample.reasoningTokens ?? 0 }, cost }
        if (record.type === 'assistant/message' && messageModel) lastModel = messageModel
        break
      }
      default:
        break
    }
  }
  const totalTokens = out.uncachedInputTokens + out.cacheReadTokens + out.cacheWriteTokens + out.outputTokens
  return { ...out, totalTokens, toolMs, llmMs, header }
}

/** Pull the same numeric fields out of the fold.js session stats object. */
function hostValues(stats) {
  const pick = (candidates) => {
    for (const name of candidates) {
      const value = stats?.[name]
      if (typeof value === 'number') return value
    }
    return undefined
  }
  const buckets = {
    uncachedInputTokens: pick(['uncachedInputTokens', 'inputTokens']),
    cacheReadTokens: pick(['cacheReadTokens']),
    cacheWriteTokens: pick(['cacheWriteTokens']),
    outputTokens: pick(['outputTokens']),
    reasoningTokens: pick(['reasoningTokens']),
  }
  // fold.js keeps the four buckets and derives the total downstream, so mirror
  // that derivation here instead of requiring a redundant field.
  const derivedTotal =
    (buckets.uncachedInputTokens ?? 0) + (buckets.cacheReadTokens ?? 0) + (buckets.cacheWriteTokens ?? 0) + (buckets.outputTokens ?? 0)
  return {
    turns: pick(['turns', 'turnCount']),
    steps: pick(['steps', 'stepCount']),
    requests: pick(['requests', 'requestCount', 'messages']),
    toolCalls: pick(['toolCalls', 'toolCallCount', 'tools']),
    ...buckets,
    totalTokens: pick(['totalTokens', 'tokens']) ?? derivedTotal,
    toolMs: pick(['toolMs', 'toolWallMs']),
    llmMs: pick(['llmMs', 'llmWallMs']),
    costCNY: pick(['costCNY']) ?? 0,
  }
}

const fields = ['turns', 'steps', 'requests', 'toolCalls', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'totalTokens', 'toolMs', 'llmMs', 'costCNY']

if (typeof fold.emptySessionStats !== 'function' || typeof fold.foldEvent !== 'function') {
  console.log('FAIL lib/fold.js does not export emptySessionStats/foldEvent as the contract requires')
  console.log('exports:', Object.keys(fold).join(', '))
  process.exitCode = 1
} else {
  const paths = listArtifacts().slice(0, Number.isFinite(limit) ? limit : undefined)
  console.log(`differential fold over ${paths.length} sessions\n`)
  let checked = 0
  let mismatched = 0
  const totals = { host: 0, reference: 0, hostCost: 0, referenceCost: 0 }
  for (const path of paths) {
    let header
    let records
    try {
      const artifact = readSessionArtifact(readFileSync(path))
      header = artifact.header
      records = artifact.records
    } catch (error) {
      failures.push(`${path}: unreadable (${error instanceof Error ? error.message : error})`)
      continue
    }
    if (!header) continue
    const stats = fold.emptySessionStats(header)
    for (const record of records) fold.foldEvent(stats, record)
    const host = hostValues(stats)
    const reference = referenceFold(header, records)
    const diffs = []
    for (const field of fields) {
      const hostValue = host[field]
      if (typeof hostValue !== 'number') {
        diffs.push(`${field}: host missing (reference ${reference[field]})`)
        continue
      }
      // costCNY 是浮点累加（峰谷价 x token），允许 1e-9 的浮点误差
      const tolerance = field === 'costCNY' ? 1e-9 : 0
      if (!(Math.abs(hostValue - reference[field]) <= tolerance)) diffs.push(`${field}: host ${hostValue} vs reference ${reference[field]}`)
    }
    totals.host += host.totalTokens ?? 0
    totals.reference += reference.totalTokens
    totals.hostCost += host.costCNY ?? 0
    totals.referenceCost += reference.costCNY
    checked += 1
    if (diffs.length > 0) {
      mismatched += 1
      const label = header.cwd ? `${String(header.id).slice(0, 20)} (${header.cwd})` : String(header.id).slice(0, 28)
      console.log(`MISMATCH ${label}`)
      for (const diff of diffs) console.log(`    ${diff}`)
    } else if (verbose) {
      console.log(`  ok ${String(header.id).slice(0, 36)} tokens=${host.totalTokens}`)
    }
  }
  console.log(`\nchecked ${checked} sessions, ${mismatched} mismatched`)
  console.log(`totalTokens: host=${totals.host} reference=${totals.reference}`)
  console.log(`costCNY(peak/off-peak): host=${totals.hostCost} reference=${totals.referenceCost}`)
  if (mismatched > 0 || totals.host !== totals.reference || Math.abs(totals.hostCost - totals.referenceCost) > 1e-9) {
    process.exitCode = 1
    console.log('\nDIFFERENTIAL FOLD FAILED')
  } else {
    console.log('\nDIFFERENTIAL FOLD PASSED — lib/fold.js matches the independent reference exactly')
  }
  for (const failure of failures) console.log(`  - ${failure}`)
}
