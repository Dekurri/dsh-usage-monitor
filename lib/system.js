/**
 * dsh-usage-monitor — 系统指标采样（Host 侧）。
 *
 * 契约（CONTRACT.md §2.2 / §3）：
 *   createSystemSampler(intervalMs) -> { sample(): LiveSystem, history: {...}, dispose(): void }
 *   runNvidiaSmi() -> Promise<object|null>            // 没有 nvidia-smi 时 resolve null，绝不抛
 *
 * 设计要点：
 * - `sample()` 是**完全同步**的：`os.cpus()` / `os.freemem()` / `process.memoryUsage()`
 *   都是廉价同步调用，保证 `getLive()` 能在 <50ms 内返回、且不触碰事件循环以外的 I/O。
 * - GPU 走子进程 `nvidia-smi`，结果进入缓存；`sample()` 只读缓存，最多每 2s 触发一次
 *   异步刷新，失败后退避 30s 再试（期间 `gpu.available=false`）。**绝不 await、绝不抛**。
 * - 历史环形缓冲保留 historyPoints 个点（默认 60），点间隔即采样周期（默认 2s）。
 *   `tokensPerMin` 需要采集器的计数器，由 collect.js 合并，不在本模块维护。
 * - 全部对外数字都做 Number.isFinite 兜底，GPU 不可用时 `name:null`、其余数值为 0
 *   （契约 §2.2 的 gpu 形状允许 `name: null`）。
 */

import { execFile } from 'node:child_process'
// 注意：本机 Node 24 的 `node:os` 里负载接口叫 `loadavg`（全小写，非标准命名），
// 另外个别平台根本没有该函数。两种名字都探测，取不到就返回 [0,0,0]。
import os from 'node:os'
import process from 'node:process'

const { cpus, freemem, totalmem } = os

/** @returns {number[]} 1/5/15 分钟负载；取不到时 [0,0,0]。 */
function readLoadAvg() {
  const loader = typeof os.loadavg === 'function' ? os.loadavg : os.loadAvg
  if (typeof loader !== 'function') return [0, 0, 0]
  try {
    const values = loader.call(os)
    return Array.isArray(values) ? values : [0, 0, 0]
  } catch {
    return [0, 0, 0]
  }
}

/** 默认采样周期（毫秒）。 */
export const DEFAULT_SAMPLE_INTERVAL_MS = 2000
/** 默认环形缓冲点数。 */
export const DEFAULT_HISTORY_POINTS = 60
/** nvidia-smi 单次调用超时（毫秒）。 */
export const GPU_TIMEOUT_MS = 1500
/** GPU 结果缓存有效期（毫秒）。 */
export const GPU_CACHE_MS = 2000
/** GPU 采集失败后的退避（毫秒）。 */
export const GPU_BACKOFF_MS = 30000

const MIB = 1024 * 1024

/** @returns {number} 有限数字，否则 0（对外数字统一兜底）。 */
function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** @returns {number} 0..100 之间。 */
function percent(part, total) {
  const whole = safeNumber(total)
  if (whole <= 0) return 0
  const value = (safeNumber(part) / whole) * 100
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
}

/** @returns {number} 整数并夹在 [min, max]。 */
function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * GPU 不可用时的占位对象（形状与契约一致，绝不返回 null 给 UI）。
 * @returns {GpuStats}
 */
export function unavailableGpu() {
  return {
    available: false,
    name: null,
    utilPercent: 0,
    memUsedBytes: 0,
    memTotalBytes: 0,
    memPercent: 0,
    tempC: 0,
    powerW: 0,
  }
}

/**
 * @typedef {Object} GpuStats
 * @property {boolean} available
 * @property {string | null} name
 * @property {number} utilPercent
 * @property {number} memUsedBytes
 * @property {number} memTotalBytes
 * @property {number} memPercent
 * @property {number} tempC
 * @property {number} powerW
 */

/**
 * 解析 `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw
 * --format=csv,noheader,nounits` 的第一行输出。
 * 某些字段可能返回 `[N/A]` / `[Not Supported]`，一律兜底为 0。
 * @param {string} stdout
 * @returns {GpuStats | null}
 */
export function parseNvidiaSmi(stdout) {
  if (typeof stdout !== 'string') return null
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry !== '')
  if (!line) return null
  const parts = line.split(',').map((part) => part.trim())
  if (parts.length < 2) return null
  const name = parts[0] !== '' && !parts[0].startsWith('[') ? parts[0] : null
  const utilPercent = safeNumber(Number.parseFloat(parts[1]))
  const memUsedMiB = safeNumber(Number.parseFloat(parts[2]))
  const memTotalMiB = safeNumber(Number.parseFloat(parts[3]))
  const tempC = safeNumber(Number.parseFloat(parts[4]))
  const powerW = safeNumber(Number.parseFloat(parts[5]))
  const memUsedBytes = memUsedMiB * MIB
  const memTotalBytes = memTotalMiB * MIB
  return {
    available: true,
    name,
    utilPercent: percent(utilPercent, 100),
    memUsedBytes,
    memTotalBytes,
    memPercent: percent(memUsedMiB, memTotalMiB),
    tempC,
    powerW,
  }
}

/**
 * 调用 nvidia-smi 取 GPU 指标。没有命令 / 超时 / 解析失败 → resolve null，永不 reject。
 * @returns {Promise<GpuStats | null>}
 */
export function runNvidiaSmi() {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = execFile(
        'nvidia-smi',
        [
          '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
          '--format=csv,noheader,nounits',
        ],
        { timeout: GPU_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * MIB },
        (error, stdout) => {
          if (error) {
            finish(null)
            return
          }
          try {
            finish(parseNvidiaSmi(stdout))
          } catch {
            finish(null)
          }
        },
      )
      // ENOENT（没装 nvidia-smi）会走 error 事件；双保险，避免挂起的 Promise。
      if (child && typeof child.on === 'function') {
        child.on('error', () => finish(null))
      }
    } catch {
      finish(null)
    }
  })
}

/**
 * 读取 host / process 的累计 CPU 时间（毫秒），供两次采样做差。
 * @returns {{ hostTicks: { idle: number, total: number }, processMs: number, at: number }}
 */
function readCpuBaseline() {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    const times = cpu && cpu.times ? cpu.times : {}
    const user = safeNumber(times.user)
    const nice = safeNumber(times.nice)
    const sys = safeNumber(times.sys)
    const irq = safeNumber(times.irq)
    const idleTime = safeNumber(times.idle)
    idle += idleTime
    total += user + nice + sys + irq + idleTime
  }
  const usage = process.cpuUsage()
  // user/system 单位是微秒；进程 CPU 只算 user+system。
  const processCpuMs = (safeNumber(usage.user) + safeNumber(usage.system)) / 1000
  return {
    hostTicks: { idle, total },
    processMs: processCpuMs,
    at: Date.now(),
  }
}

/**
 * 进程线程数（Node 24 的 process.threadCpuUsage() 返回每线程用量数组）。
 * @returns {number}
 */
function threadCount() {
  try {
    const usage = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null
    if (Array.isArray(usage)) return Math.max(1, usage.length)
  } catch {
    // 忽略：某些平台可能不可用
  }
  return 1
}

/**
 * 创建系统指标采样器。
 *
 * @param {number} [intervalMs] 采样周期，默认 2000ms
 * @param {number} [historyPoints] 环形缓冲点数，默认 60
 * @returns {{
 *   sample(): LiveSystem,
 *   history: { cpu: number[], gpu: number[], mem: number[] },
 *   dispose(): void,
 * }}
 */
export function createSystemSampler(intervalMs, historyPoints) {
  const period = clampInt(intervalMs, DEFAULT_SAMPLE_INTERVAL_MS, 250, 60_000)
  const points = clampInt(historyPoints, DEFAULT_HISTORY_POINTS, 2, 600)
  const startedAt = Date.now()

  /** @type {{ cpu: number[], gpu: number[], mem: number[] }} */
  const history = { cpu: [], gpu: [], mem: [] }

  let disposed = false
  let timer = null

  // GPU 缓存与刷新状态
  /** @type {GpuStats} */
  let gpu = unavailableGpu()
  let gpuLastAttemptAt = 0
  let gpuInFlight = false
  let gpuBackoffUntil = 0

  // CPU 基线（每两次采样做差）
  let baseline = readCpuBaseline()

  /** @type {LiveSystem | null} */
  let last = null

  /** 采样一次（同步）。 */
  function sample() {
    const now = Date.now()
    const next = readCpuBaseline()
    const elapsedMs = Math.max(1, next.at - baseline.at)

    // host CPU：全部核心的忙碌时间占比
    const idleDelta = Math.max(0, next.hostTicks.idle - baseline.hostTicks.idle)
    const totalDelta = Math.max(0, next.hostTicks.total - baseline.hostTicks.total)
    const hostCpuPercent = totalDelta > 0 ? percent(totalDelta - idleDelta, totalDelta) : 0
    // process CPU：进程 user+system 增量 / 墙钟增量
    const processCpuPercent = percent(next.processMs - baseline.processMs, elapsedMs)
    baseline = next

    const totalMem = totalmem()
    const freeMem = freemem()
    const usedMem = Math.max(0, totalMem - freeMem)
    const memory = process.memoryUsage()
    const loads = readLoadAvg()

    scheduleGpuRefresh()

    /** @type {LiveSystem} */
    const snapshot = {
      at: now,
      processMs: now - startedAt,
      process: {
        pid: safeNumber(process.pid),
        cpuPercent: processCpuPercent,
        rssBytes: safeNumber(memory.rss),
        heapUsedBytes: safeNumber(memory.heapUsed),
        heapTotalBytes: safeNumber(memory.heapTotal),
        threads: threadCount(),
      },
      host: {
        cpuPercent: hostCpuPercent,
        cores: Math.max(1, cpus().length),
        loadAvg: [safeNumber(loads[0]), safeNumber(loads[1]), safeNumber(loads[2])],
        memUsedBytes: usedMem,
        memTotalBytes: totalMem,
        memPercent: percent(usedMem, totalMem),
        freeMemBytes: freeMem,
      },
      gpu: { ...gpu },
    }

    pushHistory(history.cpu, snapshot.process.cpuPercent)
    pushHistory(history.gpu, snapshot.gpu.available ? snapshot.gpu.utilPercent : 0)
    pushHistory(history.mem, snapshot.host.memPercent)
    last = snapshot
    return snapshot
  }

  /**
   * 触发一次 GPU 后台刷新（不阻塞、不抛）。
   * 规则：距上次尝试 ≥2s；失败后 30s 内不再尝试。
   */
  function scheduleGpuRefresh() {
    if (disposed || gpuInFlight) return
    const now = Date.now()
    if (now < gpuBackoffUntil) return
    if (now - gpuLastAttemptAt < GPU_CACHE_MS) return
    gpuInFlight = true
    gpuLastAttemptAt = now
    runNvidiaSmi()
      .then((result) => {
        gpuInFlight = false
        if (disposed) return
        if (result) {
          gpu = result
          gpuBackoffUntil = 0
        } else {
          gpu = unavailableGpu()
          gpuBackoffUntil = Date.now() + GPU_BACKOFF_MS
        }
      })
      .catch(() => {
        gpuInFlight = false
        if (disposed) return
        gpu = unavailableGpu()
        gpuBackoffUntil = Date.now() + GPU_BACKOFF_MS
      })
  }

  /** 推入环形缓冲，保留最新 points 个点。 */
  function pushHistory(array, value) {
    array.push(safeNumber(value))
    if (array.length > points) array.splice(0, array.length - points)
  }

  /** 启动内部定时器（unref，避免拖住进程退出）。 */
  function startTimer() {
    if (disposed || timer !== null || typeof setInterval !== 'function') return
    timer = setInterval(() => {
      try {
        sample()
      } catch {
        // 采样失败不能影响 Host：忽略这一拍。
      }
    }, period)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  startTimer()

  return {
    sample,
    history,
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    /** 最近一次采样的快照（不触发新采样）；主要给调试/测试用。 */
    get last() {
      return last
    },
  }
}

/**
 * @typedef {Object} LiveSystem
 * @property {number} at
 * @property {number} processMs
 * @property {{ pid: number, cpuPercent: number, rssBytes: number, heapUsedBytes: number, heapTotalBytes: number, threads: number }} process
 * @property {{ cpuPercent: number, cores: number, loadAvg: number[], memUsedBytes: number, memTotalBytes: number, memPercent: number, freeMemBytes: number }} host
 * @property {GpuStats} gpu
 */

/** host 的物理内存总量（暴露给 collect 组装 live 时兜底用）。 */
export function hostMemory() {
  const total = totalmem()
  const free = freemem()
  return { total, free, used: Math.max(0, total - free) }
}
