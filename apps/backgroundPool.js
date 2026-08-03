const BasePlugin = globalThis.plugin

import { loadGlobalConfig } from "../core/config/global.js"
import { BackgroundRefreshRetryService } from "../services/render/backgroundRetry.js"

export class LotusBackgroundPool extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Background Pool",
      dsc: "Lotus local render background refresh",
      event: "message",
      priority: 20,
      rule: [],
    })
    this.task = [{
      name: "荷花插件每日背景测速与本地化",
      cron: "0 10 0 * * ? *",
      fnc: this.refresh.bind(this),
      log: false,
    }]
    this.retryService = new BackgroundRefreshRetryService()
  }

  async init() {
    try {
      const config = await loadGlobalConfig()
      this.task = [{
        name: "荷花插件每日背景测速与本地化",
        cron: config.render?.background_refresh_cron || "0 10 0 * * ? *",
        fnc: this.refresh.bind(this),
        log: false,
      }]
    } catch (error) {
      logger?.warn?.(`[Lotus-Plugin] 背景更新时间读取失败，使用默认值：${error.message}`)
    }
  }

  async refresh() {
    return this.retryService.start({ trigger: "schedule" })
  }
}
