const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import { replyForward, replyText } from "../core/transport/reply.js"
import { parseStrategyCommand, StrategySourceService } from "../services/strategy/service.js"

export class LotusStrategy extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] 三游戏攻略",
      dsc: "整合指定米游社作者的一图流攻略",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        { reg: "^#?(?:Lotus|lotus|荷花)?更新攻略作者库$", fnc: "refresh", permission: "master" },
        { reg: "^(?:#(?:原神)?|#(?:星铁|星穹铁道|崩坏星穹铁道|崩铁|绝区零|绝区)|[*%％])[\\s\\S]+?攻略$", fnc: "query" },
      ],
    })
    this.service = new StrategySourceService()
    this.task = [{ name: "荷花攻略作者库刷新", cron: "0 10 4,16 * * ? *", fnc: this.scheduledRefresh.bind(this), log: false }]
  }

  async query() {
    const parsed = parseStrategyCommand(this.e?.msg)
    if (!parsed) return false
    const result = await this.service.query(parsed.game, parsed.role)
    if (!result.ok) {
      const authors = result.authors?.join("、") || "-"
      await replyText(this, `[荷花插件]未在${result.gameLabel || parsed.game}指定作者中找到「${parsed.role}」攻略。\n已检查：${authors}${result.failures?.length ? `\n其中 ${result.failures.length} 个作者源暂时请求失败，已优先使用旧缓存。` : ""}`)
      return true
    }
    const nodes = [`${result.gameLabel}·${result.role}攻略\n共命中 ${result.items.length} 位指定作者，下方每位作者发送一篇最匹配的攻略。`, ...result.items.map(buildForwardNode)]
    await replyForward(this, nodes, { description: `${result.gameLabel}·${result.role}一图流攻略（${result.items.length}位作者）` })
    return true
  }

  async refresh() {
    if (!this.e?.isMaster) return false
    await replyText(this, "[荷花插件]正在刷新原神、星铁和绝区零攻略作者库…")
    const result = await this.service.refreshAll()
    await replyText(this, formatRefreshResult(result))
    return true
  }

  async scheduledRefresh() {
    const result = await this.service.refreshAll()
    const success = result.results.filter(item => item.ok).length
    const failed = result.results.length - success
    globalThis.logger?.[failed ? "warn" : "mark"]?.(`[Lotus-Plugin] strategy author cache refreshed: ${success} succeeded, ${failed} failed`)
    return result.ok
  }
}

function buildForwardNode(item) {
  const text = `作者：${item.author}\n${item.subject || `${item.gameLabel}攻略`}\n米游社：${item.articleUrl}`
  const image = globalThis.segment?.image
  const images = (item.images || []).slice(0, 30)
  return typeof image === "function" && images.length ? [text, ...images.map(url => image(url))] : text
}

function formatRefreshResult(result) {
  const lines = result.results.map(item => item.ok ? `✓ ${item.nickname}：${item.posts}篇` : `✗ ${item.nickname}：${item.error}${item.retained ? "（已保留旧缓存）" : ""}`)
  return `[荷花插件]攻略作者库刷新${result.ok ? "完成" : "失败"}：\n${lines.join("\n")}`
}
