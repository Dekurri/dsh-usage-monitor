/**
 * 一次性对账探针：真实全库数据上对比 TTFT 的三种口径，解释与 Lead oracle 的差异。
 *   A) Lead/oracle 口径：第一个 texts 非空的 text-chunks/reasoning-chunks 元素的 time0
 *   B) 参考实现口径（dsh-session-stats assistantStreamFirstTokenTime，lib/fold.js 采用）：
 *      首个非空 delta；run 型成员时间 = time0 + sum(dt[0..i-1])；tool-call-chunks 带 name 视为首个 token
 *   C) B 但忽略 tool-call-chunks（看工具调用 token 对 TTFT 的影响）
 *
 * 用法：node tools/probe-ttft.mjs
 * 只读：不写任何文件。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { readSessionArtifact } from './zstd-frames.mjs'

const root = process.env.DSH_SESSIONS_ROOT || path.join(os.homedir(), '.dsh', 'sessions')
const SESSION_FILE = 'session.v4.jsonl.zstd'

function findSessionFiles() {
  const found = []
  let entries
  try {
    entries = readdirSync(root, { recursive: true })
  } catch {
    return found
  }
  for (const entry of entries) {
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

/** A 口径：run 型元素 time0（要求 texts 非空），忽略 chunk 型 delta。 */
function ttftOracle(stream) {
  if (!Array.isArray(stream)) return null
  for (const record of stream) {
    if (!record || typeof record !== 'object') continue
    if (record.type !== 'text-chunks' && record.type !== 'reasoning-chunks') continue
    if (!Array.isArray(record.texts)) continue
    if (!record.texts.some((text) => typeof text === 'string' && text !== '')) continue
    return typeof record.time0 === 'number' && Number.isFinite(record.time0) ? record.time0 : null
  }
  return null
}

/** B/C 口径：对齐 dsh-session-stats。 */
function ttftReference(stream, includeToolCalls) {
  if (!Array.isArray(stream)) return null
  for (const record of stream) {
    if (!record || typeof record !== 'object') continue
    if (record.type === 'chunk') {
      const chunk = record.chunk
      if (chunk && typeof chunk === 'object') {
        const isDelta =
          ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text !== '') ||
          (chunk.type === 'tool-call-delta' && (chunk.argumentsDelta !== '' || chunk.name !== undefined))
        if (isDelta && typeof record.time === 'number' && Number.isFinite(record.time)) return record.time
      }
      continue
    }
    if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
      const members = Array.isArray(record.texts) ? record.texts : []
      const dt = Array.isArray(record.dt) ? record.dt : []
      let time = typeof record.time0 === 'number' ? record.time0 : null
      if (time === null) continue
      for (let index = 0; index < members.length; index += 1) {
        if (index > 0) time += typeof dt[index - 1] === 'number' && Number.isFinite(dt[index - 1]) ? dt[index - 1] : 0
        if (members[index] !== '') return time
      }
      continue
    }
    if (record.type === 'tool-call-chunks') {
      if (!includeToolCalls) continue
      if (record.name !== undefined && typeof record.time0 === 'number') return record.time0
      const members = Array.isArray(record.args) ? record.args : []
      const dt = Array.isArray(record.dt) ? record.dt : []
      let time = typeof record.time0 === 'number' ? record.time0 : null
      if (time === null) continue
      for (let index = 0; index < members.length; index += 1) {
        if (index > 0) time += typeof dt[index - 1] === 'number' && Number.isFinite(dt[index - 1]) ? dt[index - 1] : 0
        if (members[index] !== '') return time
      }
    }
  }
  return null
}

const files = findSessionFiles()
const stats = {
  files: files.length,
  messages: 0,
  oracle: { samples: 0, sum: 0, max: 0 },
  reference: { samples: 0, sum: 0, max: 0 },
  noTool: { samples: 0, sum: 0, max: 0 },
}

for (const file of files) {
  let artifact
  try {
    artifact = readSessionArtifact(readFileSync(file))
  } catch {
    continue
  }
  /** @type {Map<string, number>} 键必须用 `${turn}:${step}`（step 只在 turn 内唯一） */
  const openSteps = new Map()
  for (const event of artifact.records) {
    const data = event && event.data && typeof event.data === 'object' ? event.data : {}
    if (event.type === 'step/start') {
      openSteps.set(`${data.turn}:${data.step}`, typeof event.time === 'number' ? event.time : null)
    } else if (event.type === 'assistant/message') {
      stats.messages += 1
      const key = `${data.turn}:${data.step}`
      if (!openSteps.has(key)) continue
      const startTime = openSteps.get(key)
      if (typeof startTime !== 'number') continue
      const stream = data.stream
      const a = ttftOracle(stream)
      const b = ttftReference(stream, true)
      const c = ttftReference(stream, false)
      if (a !== null) {
        const value = Math.max(0, a - startTime)
        stats.oracle.samples += 1
        stats.oracle.sum += value
        stats.oracle.max = Math.max(stats.oracle.max, value)
      }
      if (b !== null) {
        const value = Math.max(0, b - startTime)
        stats.reference.samples += 1
        stats.reference.sum += value
        stats.reference.max = Math.max(stats.reference.max, value)
      }
      if (c !== null) {
        const value = Math.max(0, c - startTime)
        stats.noTool.samples += 1
        stats.noTool.sum += value
        stats.noTool.max = Math.max(stats.noTool.max, value)
      }
    } else if (event.type === 'step/end') {
      openSteps.delete(`${data.turn}:${data.step}`)
    }
  }
}

console.log(JSON.stringify({
  files: stats.files,
  assistantMessages: stats.messages,
  口径A_oracle: {
    samples: stats.oracle.samples,
    avgMs: stats.oracle.samples > 0 ? Number((stats.oracle.sum / stats.oracle.samples).toFixed(1)) : 0,
    maxMs: Number(stats.oracle.max.toFixed(1)),
  },
  口径B_reference含工具调用: {
    samples: stats.reference.samples,
    avgMs: stats.reference.samples > 0 ? Number((stats.reference.sum / stats.reference.samples).toFixed(1)) : 0,
    maxMs: Number(stats.reference.max.toFixed(1)),
  },
  口径C_reference不含工具调用: {
    samples: stats.noTool.samples,
    avgMs: stats.noTool.samples > 0 ? Number((stats.noTool.sum / stats.noTool.samples).toFixed(1)) : 0,
    maxMs: Number(stats.noTool.max.toFixed(1)),
  },
}, null, 2))
