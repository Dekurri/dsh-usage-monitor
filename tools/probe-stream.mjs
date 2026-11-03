/**
 * 探针：确认 assistant/message.stream 的真实形状（run 型 vs chunk 型），
 * 并对比两种 TTFT 折叠口径。仅离线自测用。
 */
import { readFileSync } from 'node:fs'
import { readSessionArtifact } from './zstd-frames.mjs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node tools/probe-stream.mjs <session.v4.jsonl.zstd>')
  process.exit(2)
}
const { records } = readSessionArtifact(readFileSync(file))
const messages = records.filter((r) => r.type === 'assistant/message')
console.log('assistant/message:', messages.length)

const typeCounts = new Map()
let shown = 0
for (const message of messages) {
  for (const record of message.data?.stream ?? []) {
    typeCounts.set(record?.type, (typeCounts.get(record?.type) ?? 0) + 1)
    if (shown < 6 && record?.type !== 'chunk') {
      console.log('run-record:', JSON.stringify(record).slice(0, 400))
      shown += 1
    }
  }
}
console.log('stream record types:', [...typeCounts.entries()])

const chunkTypes = new Map()
let chunkShown = 0
for (const message of messages) {
  for (const record of message.data?.stream ?? []) {
    if (record?.type !== 'chunk') continue
    chunkTypes.set(record.chunk?.type, (chunkTypes.get(record.chunk?.type) ?? 0) + 1)
    if (chunkShown < 8) {
      console.log('chunk-record:', JSON.stringify(record).slice(0, 300))
      chunkShown += 1
    }
  }
}
console.log('chunk.chunk.type:', [...chunkTypes.entries()])

// 首个 step 的 start 与首个 token 时间差
const steps = records.filter((r) => r.type === 'step/start')
const first = steps[0]
const msg = messages.find((m) => m.data?.turn === first?.data?.turn && m.data?.step === first?.data?.step)
if (first && msg) {
  const stream = msg.data.stream ?? []
  let tokenTime = null
  for (const record of stream) {
    if (record?.type === 'chunk') {
      const c = record.chunk
      if ((c?.type === 'text-delta' && c.text !== '') || (c?.type === 'reasoning-delta' && c.text !== '')) {
        tokenTime = record.time
        break
      }
    }
  }
  console.log('step/start.time', first.time, 'message.time', msg.time, 'first token time', tokenTime, 'ttft', tokenTime != null ? tokenTime - first.time : null)
}
