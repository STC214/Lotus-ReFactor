import { loadGlobalConfig } from "../../core/config/global.js"
import { refreshBackgroundPool } from "../../core/render/background.js"

export class BackgroundRefreshRetryService {
  constructor(options = {}) {
    this.refresh = options.refresh || refreshBackgroundPool
    this.loadConfig = options.loadConfig || loadGlobalConfig
    this.schedule = options.schedule || setTimeout
    this.cancel = options.cancel || clearTimeout
    this.logger = options.logger || globalThis.logger
    this.timer = null
    this.running = null
    this.chainId = 0
    this.lastResult = null
  }

  async start(context = {}) {
    if (this.running) return this.running
    this.stopPending()
    const chainId = ++this.chainId
    return this.execute(0, chainId, context)
  }

  stop() {
    this.chainId += 1
    this.stopPending()
  }

  async execute(attempt, chainId, context) {
    if (chainId !== this.chainId) return { ok: false, skipped: true, reason: "superseded" }
    const operation = this.runAttempt(attempt, chainId, context)
    this.running = operation
    try {
      return await operation
    } finally {
      if (this.running === operation) this.running = null
    }
  }

  async runAttempt(attempt, chainId, context) {
    try {
      const result = await this.refresh()
      this.stopPending()
      this.lastResult = { ...result, attempt: attempt + 1, recovered: attempt > 0 }
      if (attempt > 0) this.logger?.mark?.(`[Lotus-Plugin] 背景池第 ${attempt + 1} 次尝试更新成功`)
      return this.lastResult
    } catch (error) {
      const config = await this.loadConfig().catch(() => ({}))
      const enabled = config.render?.background_retry_enable !== false
      const delays = normalizeBackgroundRetryDelays(config.render?.background_retry_delays_minutes)
      const delayMinutes = enabled ? delays[attempt] : undefined
      const retryScheduled = Number.isFinite(delayMinutes) && chainId === this.chainId
      const result = {
        ok: false,
        attempt: attempt + 1,
        retryScheduled,
        retryInMinutes: retryScheduled ? delayMinutes : 0,
        error: error.message,
        trigger: context.trigger || "schedule",
      }
      this.lastResult = result

      if (retryScheduled) {
        this.logger?.warn?.(`[Lotus-Plugin] 背景池更新失败：${error.message}；${delayMinutes} 分钟后进行第 ${attempt + 2} 次尝试`)
        this.timer = this.schedule(() => {
          this.timer = null
          return this.execute(attempt + 1, chainId, { ...context, trigger: "retry" })
        }, delayMinutes * 60 * 1000)
        this.timer?.unref?.()
      } else {
        this.logger?.warn?.(`[Lotus-Plugin] 背景池更新失败且本轮重试结束，继续使用上一批：${error.message}`)
      }
      return result
    }
  }

  stopPending() {
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = null
  }
}

export function normalizeBackgroundRetryDelays(value) {
  const source = Array.isArray(value) ? value : String(value || "10,30,60").split(/[\s,]+/)
  const delays = source
    .map(Number)
    .filter(item => Number.isFinite(item) && item > 0 && item <= 1440)
    .map(item => Math.round(item * 100) / 100)
  return delays.length ? delays : [10, 30, 60]
}
