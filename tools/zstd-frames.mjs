/**
 * Reader for DSH's concatenated Zstandard session-log container.
 *
 * `@deepseek-ai/dsh-session-persistence-jsonl` appends one independently
 * decodable, checksummed Zstandard frame per durable batch (session header
 * first, then each event batch). Node's `zlib.zstdDecompressSync` stops after
 * the first frame, so reading a whole log needs a structural frame scan first:
 * this module walks the RFC 8878 frame header and block headers without
 * decompressing, then decompresses each frame separately.
 *
 * Offline tooling only — the plugin's runtime path reads sessions through
 * `ctx.sessionQuery`, which already owns this decoding.
 */

import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MIN = 0x184d2a50
const SKIPPABLE_MAX = 0x184d2a5f

/**
 * Locate every structurally complete frame in a concatenated Zstandard stream.
 * @param {Buffer} buffer - bytes of one session artifact.
 * @returns {{ frames: Array<{start: number, end: number}>, tornStart: number | undefined }}
 *   complete frame ranges (file order) and, when EOF lands inside a frame, its start.
 * @throws when a complete frame is structurally invalid.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let p = 0
  while (p < buffer.length) {
    if (p + 4 > buffer.length) return { frames, tornStart: p }
    const word = buffer.readUInt32LE(p)
    if (word >= SKIPPABLE_MIN && word <= SKIPPABLE_MAX) {
      if (p + 8 > buffer.length) return { frames, tornStart: p }
      const size = buffer.readUInt32LE(p + 4)
      if (p + 8 + size > buffer.length) return { frames, tornStart: p }
      p += 8 + size
      continue
    }
    if (word !== ZSTD_MAGIC) {
      throw new Error(`not a zstd frame at offset ${p} (magic 0x${word.toString(16)})`)
    }
    const start = p
    p += 4
    if (p + 1 > buffer.length) return { frames, tornStart: start }
    const descriptor = buffer[p]
    p += 1
    const contentSizeFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictionaryFlag = descriptor & 3
    if (!singleSegment) p += 1
    p += [0, 1, 2, 4][dictionaryFlag]
    p += contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : [0, 2, 4, 8][contentSizeFlag]
    if (p > buffer.length) return { frames, tornStart: start }

    let lastBlock = 0
    while (!lastBlock) {
      if (p + 3 > buffer.length) return { frames, tornStart: start }
      const header = buffer[p] | (buffer[p + 1] << 8) | (buffer[p + 2] << 16)
      p += 3
      lastBlock = header & 1
      const blockType = (header >>> 1) & 3
      const blockSize = header >>> 3
      if (blockType === 0) p += blockSize
      else if (blockType === 1) p += 1
      else if (blockType === 2) p += blockSize
      else throw new Error(`reserved zstd block type at offset ${p - 3}`)
      if (p > buffer.length) return { frames, tornStart: start }
    }
    if (checksum) p += 4
    if (p > buffer.length) return { frames, tornStart: start }
    frames.push({ start, end: p })
  }
  return { frames, tornStart: undefined }
}

/**
 * Decode one whole concatenated session artifact to UTF-8 text.
 * A torn final frame (crash between batches) is dropped, matching the Host's
 * own truncation repair.
 * @param {Buffer} buffer - bytes of one session artifact.
 * @returns {{ text: string, frames: number, torn: boolean }}
 */
export function decodeSessionLog(buffer) {
  const scan = scanZstdFrames(buffer)
  const parts = []
  for (const frame of scan.frames) {
    parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
  }
  return {
    text: Buffer.concat(parts).toString('utf8'),
    frames: scan.frames.length,
    torn: scan.tornStart !== undefined,
  }
}

/**
 * Decode a session artifact into parsed JSONL records.
 * @param {Buffer} buffer - bytes of one session artifact.
 * @returns {{ header: object | null, records: object[], frames: number, torn: boolean }}
 */
export function readSessionArtifact(buffer) {
  const { text, frames, torn } = decodeSessionLog(buffer)
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    records.push(JSON.parse(trimmed))
  }
  const header = records.length > 0 && records[0].type === 'session' ? records.shift() : null
  return { header, records, frames, torn }
}
