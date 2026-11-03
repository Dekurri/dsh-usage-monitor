/**
 * 冒烟自测：fold.js 的口径、序列化往返、重试替换、价格表。
 * 用法：node tools/smoke-fold.mjs
 */
import {
  emptySessionStats,
  foldEvent,
  sumTokens,
  cacheHitRateOf,
  priceFor,
  costOf,
  serializeSessionStats,
  reviveSessionStats,
} from '../lib/fold.js'

const s = emptySessionStats({ id: 's1', createdAt: 1000, cwd: 'C:\\x' })
foldEvent(s, { type: 'step/start', seq: 1, time: 1_000_000, data: { turn: 1, step: 1 } })
foldEvent(s, {
  type: 'assistant/message',
  seq: 2,
  time: 1_000_900,
  data: {
    turn: 1,
    step: 1,
    message: { source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } },
    stream: [{ type: 'reasoning-chunks', time0: 1_000_200, index: 0, dt: [0, 10], texts: ['a', 'b'] }],
    usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 900, cacheWriteTokens: 0, totalTokens: 1200 },
  },
})
foldEvent(s, { type: 'tool/call', seq: 3, time: 1_001_000, data: { callId: 'c1', turn: 1, step: 1 } })
foldEvent(s, { type: 'tool/result', seq: 4, time: 1_001_500, data: { message: { source: { kind: 'tool', callId: 'c1' } } } })
foldEvent(s, { type: 'step/end', seq: 5, time: 1_002_000, data: { turn: 1, step: 1 } })
foldEvent(s, { type: 'turn/end', seq: 6, time: 1_002_100, data: { turn: 1, reason: { kind: 'completed' } } })
foldEvent(s, { type: 'unknown/whatever', seq: 7, time: 1_002_200, data: {} })

console.log('tokens', sumTokens(s), 'requests', s.requests, 'turns', s.turns, 'steps', s.steps, 'toolCalls', s.toolCalls)
console.log('ttftCount', s.ttftCount, 'ttftMs', s.ttftMs, 'decodeMs', s.decodeMs, 'tps', s.tpsSamples, 'llmMs', s.llmMs, 'toolMs', s.toolMs)
console.log('cacheHitRate', cacheHitRateOf(s).toFixed(4), 'expect', (900 / 1000).toFixed(4))
console.log('price', priceFor('deepseek-flash'), 'cost', costOf(s, priceFor('deepseek-flash')).toFixed(8))
console.log('unknown price', priceFor('no-such-model'), 'cost', costOf(s, priceFor('no-such-model')))
console.log('hours', s.hours.size, 'models', JSON.stringify([...s.models.values()]))

const raw = serializeSessionStats(s)
const back = reviveSessionStats(JSON.parse(JSON.stringify(raw)))
console.log('roundtrip', sumTokens(back) === sumTokens(s), back.hours.size, back.models.size, back.ttftSamples.length, back.tpsSamples.length)

// 重试语义（严格对齐 dsh-token-meter addReplacing）：
//   · assistant/attempt 的 stream usage 也计入；
//   · 同 (turn, step) 的新采样替换旧采样（不是累加）；同值重放不重复累加；
//   · llm/retry-started 只在 (turn, step) 匹配时清采样引用，绝不撤回已计入用量；
//   · requests = assistant/message 条数，单调不减。
const t = emptySessionStats({ id: 's2' })
foldEvent(t, { type: 'step/start', seq: 1, time: 2_000_000, data: { turn: 1, step: 1 } })
foldEvent(t, {
  type: 'assistant/attempt',
  seq: 2,
  time: 2_000_400,
  data: {
    turn: 1,
    step: 1,
    stream: [
      { type: 'chunk', time: 2_000_300, chunk: { type: 'usage', usage: { inputTokens: 15, outputTokens: 3 } } },
      { type: 'chunk', time: 2_000_350, chunk: { type: 'text-delta', text: 'hi' } },
    ],
  },
})
const afterAttempt = sumTokens(t)
foldEvent(t, {
  type: 'assistant/message',
  seq: 3,
  time: 2_000_500,
  data: {
    turn: 1,
    step: 1,
    message: { source: { provider: 'p', model: 'm' } },
    stream: [{ type: 'chunk', time: 2_000_300, chunk: { type: 'text-delta', text: 'hi' } }],
    usage: { inputTokens: 20, outputTokens: 10 },
  },
})
const afterReplace = sumTokens(t)
foldEvent(t, {
  type: 'assistant/message',
  seq: 4,
  time: 2_000_550,
  data: {
    turn: 1,
    step: 1,
    message: { source: { provider: 'p', model: 'm' } },
    stream: [{ type: 'chunk', time: 2_000_300, chunk: { type: 'text-delta', text: 'hi' } }],
    usage: { inputTokens: 20, outputTokens: 10 },
  },
})
const afterDuplicate = sumTokens(t)
foldEvent(t, { type: 'llm/retry-started', seq: 5, time: 2_000_700, data: { turn: 9, step: 9 } })
const afterNonMatchingRetry = sumTokens(t)
foldEvent(t, { type: 'llm/retry-started', seq: 6, time: 2_000_800, data: { turn: 1, step: 1 } })
foldEvent(t, {
  type: 'assistant/message',
  seq: 7,
  time: 2_000_900,
  data: {
    turn: 1,
    step: 1,
    message: { source: { provider: 'p', model: 'm' } },
    stream: [{ type: 'chunk', time: 2_000_850, chunk: { type: 'text-delta', text: 'ok' } }],
    usage: { inputTokens: 4, outputTokens: 1 },
  },
})
const afterMatchedRetry = sumTokens(t)
const retryOk =
  afterAttempt === 18 &&
  afterReplace === 30 &&
  afterDuplicate === 30 &&
  afterNonMatchingRetry === 30 &&
  afterMatchedRetry === 35 &&
  t.requests === 3
console.log(
  'retry semantics',
  JSON.stringify({ afterAttempt, afterReplace, afterDuplicate, afterNonMatchingRetry, afterMatchedRetry, requests: t.requests, ttftSamples: t.ttftSamples.length, models: t.models.size }),
  retryOk ? 'OK' : 'FAIL',
)

// 边界：NaN / 负数 / 缺失 usage 不允许漏成 NaN
const u = emptySessionStats(null)
foldEvent(u, { type: 'assistant/message', seq: 1, time: Number.NaN, data: { turn: 1, step: 1, message: null, usage: { inputTokens: Number.NaN, outputTokens: -5 } } })
console.log('degenerate', sumTokens(u), u.requests, cacheHitRateOf(u), Number.isFinite(u.avgX), JSON.stringify(u.ttftCount))
