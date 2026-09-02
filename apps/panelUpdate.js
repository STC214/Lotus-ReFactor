const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"
import {
  isMissingProfileError,
  listAllProfiles,
  loadProfile,
  parseProfileIdFromMessage,
  profileLoginRequiredMessage,
  PROFILE_ID_SUFFIX_PATTERN,
} from "../core/config/profile.js"
import { loadGlobalConfig } from "../core/config/global.js"
import { renderStatusCard } from "../core/render/service.js"
import { AccountService } from "../core/login/account.js"
import { PermissionService } from "../core/permissions/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { MiaoPanelBridge } from "../services/pluginBridge/miaoPanel.js"
import { ZzzPanelBridge } from "../services/pluginBridge/zzzPanel.js"
import { getRoleUid, importRuntimeModule, pickRole } from "../services/pluginBridge/common.js"
import { parsePanelUidIndex, resolveEventUidByIndex } from "../services/pluginBridge/uidIndex.js"

export class LotusPanelUpdate extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Panel Update",
      dsc: "Lotus profile aware miao panel update",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        {
          reg: "^#(原神)?(更新面板|面板更新|全部面板更新|更新全部面板)[uU][iI][dD][1-9]\\d{0,2}$",
          fnc: "genshinPanelByUidIndex",
        },
        {
          reg: "^(#星铁|\\*)(更新面板|面板更新|全部面板更新|更新全部面板)[uU][iI][dD][1-9]\\d{0,2}$",
          fnc: "starRailPanelByUidIndex",
        },
        {
          reg: `^#(原神)?(更新面板|面板更新|全部面板更新|更新全部面板)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "genshinPanel",
        },
        {
          reg: `^#星铁(更新面板|面板更新|全部面板更新|更新全部面板)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "starRailPanel",
        },
        {
          reg: `^\\*(更新面板|面板更新|全部面板更新|更新全部面板)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "starRailPanel",
        },
        {
          reg: `^#绝区零(更新面板|面板更新|全部面板更新|更新全部面板)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "zzzPanel",
        },
        {
          reg: `^[%％](更新面板|面板更新|全部面板更新|更新全部面板)${PROFILE_ID_SUFFIX_PATTERN}$`,
          fnc: "zzzPanel",
        },
        {
          reg: "^#(?:修复|重建|重刷|清理)(?:原铁|原神星铁|原神和星铁|面板|面板缓存|面板数据|排名数据|个人查询缓存)(?:\\s+间隔\\d{1,3})?$",
          fnc: "repairMiaoPanelData",
        },
      ],
    })
  }

  async genshinPanel() {
    return this.updatePanel("gs")
  }

  async starRailPanel() {
    return this.updatePanel("sr")
  }

  async zzzPanel() {
    return this.updatePanel("zzz")
  }

  async genshinPanelByUidIndex() {
    return this.updatePanelByUidIndex("gs")
  }

  async starRailPanelByUidIndex() {
    return this.updatePanelByUidIndex("sr")
  }

  async updatePanelByUidIndex(game) {
    const index = parsePanelUidIndex(this.e.msg)
    try {
      const selection = await resolveEventUidByIndex(this.e, index, game)
      const result = await new MiaoPanelBridge().updatePanelByUid({
        e: this.e,
        uid: selection.uid,
        game,
        forwardReplies: true,
      })

      if (!result.forwarded.length) {
        const message = pickMessage(result.messages) || "面板更新已执行，但 miao-plugin 没有返回图片。"
        await replyText(this, `[荷花插件]UID${selection.index}（${selection.uid}）：${message}`)
      }
    } catch (error) {
      logger?.error?.(`[Lotus-Plugin] uid index panel update failed: ${error.stack || error.message}`)
      await replyText(this, `[荷花插件]${error.message}`)
    }
    return true
  }

  async updatePanel(game) {
    const userId = String(this.e.user_id)
    const profileId = parseProfileIdFromMessage(this.e.msg)
    try {
      // 无 profile 后缀时遵循 miao/TRSS 当前激活 UID；带数字后缀仍明确更新指定 profile。
      // 这样 #更新面板 不会因为 Lotus 的 profile-1 与 miao 当前账号不同而更新错账号。
      if (!hasPanelProfileSuffix(this.e.msg)) {
        const activeUid = await resolveActiveUid(this.e, game)
        if (activeUid && ["gs", "sr"].includes(game)) {
          const result = await new MiaoPanelBridge().updatePanelByUid({
            e: this.e,
            uid: activeUid,
            game,
            forwardReplies: true,
          })
          logger?.info?.(`[Lotus-Plugin] default panel update uses active ${game} UID ${activeUid}`)
          if (!result.forwarded.length) {
            const message = pickMessage(result.messages) || "面板更新已执行，但外部插件没有返回图片。"
            await replyText(this, `[荷花插件]${message}`)
          }
          return true
        }
      }
      const loadedProfile = await loadProfile(userId, profileId)
      if (game === "zzz") {
        await replyText(this, "[荷花插件]正在更新绝区零面板，请稍候。")
      }
      const profile = await refreshProfileBeforePanel(userId, profileId, loadedProfile)
      const result = await panelBridgeForGame(game).updatePanel({
        e: this.e,
        profile,
        profileId,
        game,
        forwardReplies: true,
      })

      if (!result.forwarded.length) {
        const message = pickMessage(result.messages) || "面板更新已执行，但外部插件没有返回图片。"
        await replyText(this, `[荷花插件]${message}`)
      }
    } catch (error) {
      if (isMissingProfileError(error)) {
        await replyText(this, `[荷花插件]${profileLoginRequiredMessage(profileId)}`)
        return true
      }

      logger?.error?.(`[Lotus-Plugin] panel update failed: ${error.stack || error.message}`)
      const image = await renderStatusCard({
        title: "面板更新",
        subtitle: `QQ ${userId} · Profile ${profileId}`,
        badge: "失败",
        message: error.message,
        userId,
        items: [
          { label: "游戏", value: gameLabel(game) },
          { label: "建议", value: `检查 profile 登录态、UID 与 ${game === "zzz" ? "ZZZ-Plugin" : "miao-plugin"} 是否可加载。` },
        ],
      }, {
        saveId: `lotus-panel-error-${userId}-${profileId}-${game}`,
      })
      await replyImage(this, image, `[荷花插件]面板更新失败：${error.message}`)
    }

    return true
  }

  async repairMiaoPanelData() {
    const userId = String(this.e.user_id)
    const globalConfig = await loadGlobalConfig()
    if (!new PermissionService({ permissions: globalConfig.permissions }).isMaster(this.e)) {
      await replyText(this, "[荷花插件]只有 bot 主人可以批量修复原神/星铁面板数据。")
      return true
    }

    const intervalMs = parseRepairInterval(this.e.msg)
    await replyText(this, `[荷花插件]开始清理原神/星铁面板缓存并重建，更新间隔 ${Math.round(intervalMs / 1000)} 秒。`)
    const result = await rebuildAllMiaoPanels({ intervalMs, e: this.e })
    const okCount = result.updates.filter(item => item.ok).length
    const image = await renderStatusCard({
      title: "面板缓存修复",
      subtitle: "原神 / 星铁 profile 数据",
      badge: `${okCount}/${result.updates.length}`,
      message: `已清理 ${result.deleted.length} 个 UID 的 miao 面板数据与排名索引，并按 profile 重新更新。`,
      userId,
      items: result.updates.slice(0, 14).map(item => ({
        label: `QQ ${item.qq} · P${item.profileId} · ${gameLabel(item.game)}`,
        value: item.ok ? `更新成功 · UID ${item.uid}` : `失败：${item.error}`.slice(0, 70),
      })),
    }, {
      saveId: `lotus-miao-panel-repair-${userId}`,
    })
    await replyImage(this, image, "[荷花插件]原神/星铁面板缓存修复完成。")
    return true
  }
}

function hasPanelProfileSuffix(message = "") {
  return /(?:更新面板|面板更新|全部面板更新|更新全部面板)\s*[1-9]\d{0,2}$/i.test(String(message).trim())
}

async function resolveActiveUid(event, game) {
  const user = event?.user
  try {
    if (typeof user?.getUid === "function") {
      const uid = await user.getUid(game)
      if (/^[1-9]\d{7,9}$/.test(String(uid || ""))) return String(uid)
    }
  } catch (error) {
    logger?.debug?.(`[Lotus-Plugin] active UID lookup skipped: ${error.message}`)
  }

  for (const candidate of [user?.uid, event?.uid, event?._mys?.uid]) {
    if (/^[1-9]\d{7,9}$/.test(String(candidate || ""))) return String(candidate)
  }
  return ""
}

async function rebuildAllMiaoPanels({ intervalMs = 8000, e } = {}) {
  const profiles = await listAllProfiles()
  const Player = await loadMiaoPlayer().catch(error => {
    throw new Error(`miao Player 不可用：${error.message}`)
  })
  const deleted = []
  const seen = new Set()
  for (const profile of profiles) {
    for (const game of ["gs", "sr"]) {
      const uid = getRoleUid(pickRole(profile, game))
      if (!uid) continue
      const key = `${game}:${uid}`
      if (seen.has(key)) continue
      seen.add(key)
      Player.delByUid?.(uid, game)
      deleted.push({ uid, game })
    }
  }

  const updates = []
  const bridge = new MiaoPanelBridge()
  const jobs = []
  for (const profile of profiles) {
    for (const game of ["gs", "sr"]) {
      const uid = getRoleUid(pickRole(profile, game))
      if (!uid) continue
      jobs.push({ profile, game, uid })
    }
  }

  for (const [index, job] of jobs.entries()) {
    const qq = String(job.profile.user?.qq || "")
    const profileId = job.profile.profile?.id || 1
    try {
      const refreshed = await refreshProfileBeforePanel(qq, profileId, job.profile)
      await bridge.updatePanel({
        e: { ...e, user_id: qq },
        profile: refreshed,
        profileId,
        game: job.game,
        forwardReplies: false,
      })
      updates.push({ qq, profileId, game: job.game, uid: job.uid, ok: true })
    } catch (error) {
      updates.push({ qq, profileId, game: job.game, uid: job.uid, ok: false, error: error.message })
    }
    if (index < jobs.length - 1 && intervalMs > 0) await sleep(intervalMs)
  }

  return { deleted, updates }
}

async function loadMiaoPlayer() {
  const mod = await importRuntimeModule("miao-plugin", "models", "Player.js")
  return mod.default
}

async function refreshProfileBeforePanel(userId, profileId, profile) {
  if (!profile?.account?.stoken) return profile
  try {
    return await new AccountService().refresh(userId, profileId)
  } catch (error) {
    logger?.debug?.(`[Lotus-Plugin] panel pre-refresh skipped: ${error.message}`)
    return profile
  }
}

function panelBridgeForGame(game) {
  if (game === "zzz") return new ZzzPanelBridge()
  return new MiaoPanelBridge()
}

function gameLabel(game) {
  if (game === "sr") return "星铁"
  if (game === "zzz") return "绝区零"
  return "原神"
}

function pickMessage(messages = []) {
  return messages
    .filter(message => message && message !== "[图片]" && message !== "[按钮]")
    .join("\n")
    .slice(0, 180)
}

function parseRepairInterval(message = "") {
  const match = String(message || "").match(/间隔(\d{1,3})/)
  const seconds = match ? Number(match[1]) : 8
  return Math.min(60, Math.max(0, seconds)) * 1000
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
