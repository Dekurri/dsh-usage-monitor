/**
 * 冒烟自测：system.js 的采样、GPU 探测（无 nvidia-smi 时应静默 unavailable）、
 * 环形缓冲裁剪。用法：node tools/smoke-system.mjs
 */
import { createSystemSampler, runNvidiaSmi, parseNvidiaSmi } from '../lib/system.js'

console.log('parseNvidiaSmi sample:', parseNvidiaSmi('NVIDIA GeForce RTX 4090, 12, 1024, 24564, 45, [N/A]\n'))
console.log('parseNvidiaSmi junk:', parseNvidiaSmi(''))

const t0 = performance.now()
const gpu = await runNvidiaSmi()
const elapsed = (performance.now() - t0).toFixed(1)
console.log(`runNvidiaSmi -> ${JSON.stringify(gpu)} (${elapsed}ms)`)

const sampler = createSystemSampler(250, 5)
for (let i = 0; i < 7; i += 1) {
  const snapshot = sampler.sample()
  console.log(
    'sample',
    i,
    'proc cpu',
    snapshot.process.cpuPercent.toFixed(1),
    'host cpu',
    snapshot.host.cpuPercent.toFixed(1),
    'mem',
    snapshot.host.memPercent.toFixed(1),
    'gpu.available',
    snapshot.gpu.available,
    'history',
    JSON.stringify({ cpu: sampler.history.cpu.length, gpu: sampler.history.gpu.length, mem: sampler.history.mem.length }),
  )
  await new Promise((resolve) => setTimeout(resolve, 60))
}
const live = sampler.sample()
console.log('live keys:', Object.keys(live), 'process keys:', Object.keys(live.process), 'host keys:', Object.keys(live.host), 'gpu keys:', Object.keys(live.gpu))
console.log('finite check:', [live.process.cpuPercent, live.process.rssBytes, live.host.cpuPercent, live.host.memPercent, live.gpu.utilPercent].every(Number.isFinite))
console.log('loadAvg', live.host.loadAvg, 'threads', live.process.threads, 'cores', live.host.cores)
sampler.dispose()
sampler.dispose() // 幂等
await new Promise((resolve) => setTimeout(resolve, 400))
console.log('after dispose history frozen at', sampler.history.cpu.length)
