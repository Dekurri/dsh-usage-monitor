// 临时探测脚本：验证 zstd 多帧解析器（自定义帧边界walker）。
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 0xfd2fb528;

export function* zstdFrameRanges(buf) {
  let off = 0;
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) {
      throw new Error(`bad zstd magic at ${off}`);
    }
    const start = off;
    off += 4;
    const fhd = buf[off];
    off += 1;
    const fcsFlag = fhd >> 6;
    const singleSegment = (fhd >> 5) & 1;
    const checksumFlag = (fhd >> 2) & 1;
    const dictIdFlag = fhd & 3;
    if (!singleSegment) off += 1; // window descriptor
    if (dictIdFlag === 1) off += 1;
    else if (dictIdFlag === 2) off += 2;
    else if (dictIdFlag === 3) off += 4;
    if (fcsFlag === 0) {
      if (singleSegment) off += 1;
    } else off += fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
    for (;;) {
      const h = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
      off += 3;
      const last = h & 1;
      const type = (h >> 1) & 3;
      const size = h >>> 3;
      if (type === 0) off += size;
      else if (type === 1) off += 1;
      else if (type === 2) off += size;
      else throw new Error(`reserved block type at ${off - 3}`);
      if (last) break;
    }
    if (checksumFlag) off += 4;
    if (off > buf.length) throw new Error(`frame overflow at ${start}`);
    yield [start, off];
  }
}

const path = process.argv[2];
const buf = readFileSync(path);
const t0 = performance.now();
let frames = 0;
let bytes = 0;
let lines = 0;
const typeAll = new Map();
for (const [start, end] of zstdFrameRanges(buf)) {
  const text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
  frames += 1;
  bytes += text.length;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    lines += 1;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    typeAll.set(obj.type, (typeAll.get(obj.type) ?? 0) + 1);
    if (obj.type === 'assistant/message') {
      if (typeAll.get('__usageSample') === undefined) {
        console.log('usage sample:', JSON.stringify(obj.data.usage));
        console.log('assistant keys:', JSON.stringify(Object.keys(obj.data)));
        typeAll.set('__usageSample', 1);
      }
    }
  }
}
const t1 = performance.now();
console.log({ frames, decompressedBytes: bytes, lines, ms: Math.round(t1 - t0) });
console.log('types:', JSON.stringify([...typeAll.entries()].filter(([k]) => !k.startsWith('__')).sort((a, b) => b[1] - a[1])));
