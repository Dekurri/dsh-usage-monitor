/**
 * Compare today's local log totals with the DeepSeek open-platform Usage page.
 *
 * The platform reports billing-side aggregates (account-wide, ~5 min delayed);
 * this script reproduces the same window from local session logs so the two
 * numbers can be put side by side instead of guessed at.
 *
 *   node tools/probe-today.mjs [--tz-offset +08:00] [--since ISO]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readSessionArtifact } from './zstd-frames.mjs'

const root = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'sessions') : path.join(os.homedir(), '.dsh', 'sessions')
const files = []
;(function walk(dir, depth) {
  if (depth > 3) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, depth + 1)
    else if (entry.name === 'session.v4.jsonl.zstd') files.push(p)
  }
})(root, 0)

// Asia/Shanghai midnight, in epoch ms.
const now = Date.now()
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const dayStart = Math.floor((now + SHANGHAI_OFFSET_MS) / 86400000) * 86400000 - SHANGHAI_OFFSET_MS

function lastUsageChunk(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const c = stream[i]?.chunk
    if (c && c.type === 'usage' && c.usage) return c.usage
  }
  return undefined
}
function usageOf(event) {
  const data = event.data ?? {}
  if (event.type === 'assistant/message' && data.usage !== undefined) return data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastUsageChunk(data.stream)
}
const bucket = () => ({ uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, reason: 0 })
function add(b, u) {
  if (!u) return
  b.uncached += u.inputTokens ?? 0
  b.cacheRead += u.cacheReadTokens ?? 0
  b.cacheWrite += u.cacheWriteTokens ?? 0
  b.output += u.outputTokens ?? 0
  b.reason += u.reasoningTokens ?? 0
}
const total = (b) => b.uncached + b.cacheRead + b.cacheWrite + b.output

const msgOnly = bucket()       // authoritative token-meter style: assistant/message.usage
const attemptAll = bucket()    // every API attempt that reported usage
const perModel = new Map()
let msgCount = 0
let attemptCount = 0
let sessionsToday = 0

for (const file of files) {
  let artifact
  try { artifact = readSessionArtifact(fs.readFileSync(file)) } catch { continue }
  let touched = false
  let lastModel = null
  for (const record of artifact.records ?? []) {
    if (typeof record.time === 'number' && record.time < dayStart) continue
    if (record.type === 'assistant/message') {
      const src = record.data?.message?.source
      if (src && src.kind === 'model') lastModel = `${src.provider}/${src.model}`
    }
    const usage = usageOf(record)
    if (!usage) continue
    touched = true
    if (record.type === 'assistant/message') {
      msgCount += 1
      add(msgOnly, usage)
      const key = lastModel ?? 'unknown'
      if (!perModel.has(key)) perModel.set(key, { requests: 0, tokens: 0 })
      const m = perModel.get(key)
      m.requests += 1
      m.tokens += total(usage)
    } else {
      attemptCount += 1
      add(attemptAll, usage)
    }
  }
  if (touched) sessionsToday += 1
}

const fmt = (n) => n.toLocaleString('en-US')
console.log(`window: ${new Date(dayStart).toISOString()} .. now (Asia/Shanghai day start)`)
console.log(`sessions touched today: ${sessionsToday} / ${files.length}`)
console.log('')
console.log(`A) assistant/message usage only : requests=${fmt(msgCount)} tokens=${fmt(total(msgOnly))}`)
console.log(`   uncached=${fmt(msgOnly.uncached)} cacheRead=${fmt(msgOnly.cacheRead)} cacheWrite=${fmt(msgOnly.cacheWrite)} output=${fmt(msgOnly.output)}`)
console.log(`B) all attempts with usage      : attempts=${fmt(attemptCount)} tokens=${fmt(total(attemptAll))}`)
console.log(`   uncached=${fmt(attemptAll.uncached)} cacheRead=${fmt(attemptAll.cacheRead)} cacheWrite=${fmt(attemptAll.cacheWrite)} output=${fmt(attemptAll.output)}`)
console.log('')
console.log('platform (screenshot): requests=380 tokens=29,945,558 cost=¥3.02 CNY')
console.log('')
const chit = (b) => (b.uncached + b.cacheRead + b.cacheWrite) > 0 ? b.cacheRead / (b.uncached + b.cacheRead + b.cacheWrite) : 0
console.log(`cache hit rate A=${(chit(msgOnly) * 100).toFixed(2)}%  B=${(chit(attemptAll) * 100).toFixed(2)}%`)
console.log('')
console.log('per model (assistant/message):')
for (const [key, v] of [...perModel.entries()].sort((a, b) => b[1].tokens - a[1].tokens)) console.log(`  ${key}: requests=${fmt(v.requests)} tokens=${fmt(v.tokens)}`)
console.log('')
// What per-1M blended price does the platform charge for this window?
for (const [label, b] of [['A', msgOnly], ['B', attemptAll]]) {
  const t = total(b)
  if (t > 0) console.log(`${label}: implied blended ¥/${(3.02 / (t / 1e6)).toFixed(4)} per 1M tokens (if ¥3.02 covered exactly these tokens)`)
}
