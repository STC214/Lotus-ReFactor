import { refreshAccountAndSync } from "../../core/login/refresh.js"
import { loadProfile } from "../../core/config/profile.js"
import { AccountService } from "../../core/login/account.js"
import { renderTemplate } from "../../core/render/service.js"
import { MiyousheTasks } from "../miyoushe/tasks.js"
import { appendCheckinAudit } from "./audit.js"
import { beginLotusSignin } from "../../core/coordination/signinPriority.js"
import { createProfileRequestGuard } from "../../core/login/requestGuard.js"

export class ProfileSigninService {
  constructor(options = {}) {
    this.account = options.account || new AccountService(options)
    this.runner = options.runner || new MiyousheTasks(options)
    this.render = options.render !== false
    this.beforeRequest = options.beforeRequest
    this.renderResult = options.renderSigninResult || renderSigninResult
    this.renderFailure = options.renderSigninFailure || renderSigninFailure
    this.appendAudit = options.appendAudit || appendCheckinAudit
  }

  async run({ qq, profileId = 1, profile, refresh = true, onCaptchaEvent, installRequirements = false, source = "manual", timeoutMs, beforeRequest = this.beforeRequest } = {}) {
    const releaseSigninPriority = await beginLotusSignin()
    try {
      return await this.runWithPriority({ qq, profileId, profile, refresh, onCaptchaEvent, installRequirements, source, timeoutMs, beforeRequest })
    } finally {
      releaseSigninPriority()
    }
  }

  async runWithPriority({ qq, profileId = 1, profile, refresh = true, onCaptchaEvent, installRequirements = false, source = "manual", timeoutMs, beforeRequest = this.beforeRequest } = {}) {
    const userId = String(qq || profile?.user?.qq || "")
    const id = Number(profileId || profile?.profile?.id || 1)
    let activeProfile = profile || await loadProfile(userId, id)

    if (refresh) {
      try {
        activeProfile = await refreshAccountAndSync(userId, id, { accountService: this.account, expectedProfile: activeProfile })
      } catch (error) {
        return this.failure({
          stage: "refresh",
          profile: activeProfile,
          error,
          message: "签到前刷新登录信息失败，本次签到已停止。",
          advice: "请重新扫码登录对应 profile，或检查 stoken 是否已失效。",
          source,
        })
      }
    }

    if (!activeProfile.account?.cookie) {
      return this.failure({
        stage: "precheck",
        profile: activeProfile,
        error: new Error("profile has no cookie"),
        message: "profile 尚未保存 cookie，无法执行签到。",
        advice: "请先使用 #扫码登录 绑定当前 profile。",
        source,
      })
    }

    const skipped = collectSkipped(activeProfile)
    let result
    try {
      const guard = beforeRequest || createProfileRequestGuard(activeProfile, {
        qq: userId, profileId: id,
        ...(typeof this.account.get === "function" ? { loadProfile: (user, slot) => this.account.get(user, slot) } : {}),
      })
      result = await runSigninWithTimeout(this.runner, prepareRunnableProfile(activeProfile), {
        installRequirements, timeoutMs, onCaptchaEvent, beforeRequest: guard,
      })
    } catch (error) {
      return this.failure({
        stage: error?.code === "LOTUS_RUNNER_TIMEOUT" ? "timeout" : "runner",
        profile: activeProfile,
        error,
        message: "MihoyoBBSTools runner 执行失败。",
        advice: "先执行 #初始化签到环境，确认 profile 登录态、设备信息和 Python 依赖。",
        source,
      })
    }

    let image = null
    if (this.render) {
      try {
        image = await this.renderResult({ result, profile: activeProfile, skipped })
      } catch (error) {
        globalThis.logger?.warn?.(`[Lotus-Plugin] signin result render failed, keeping runner outcome: ${error.message}`)
      }
    }
    const outcome = {
      ok: Boolean(result.ok),
      stage: "checkin",
      source,
      profile: activeProfile,
      result,
      skipped,
      image,
      message: result.message || (result.ok ? "签到完成。" : "签到失败。"),
    }
    await this.audit(outcome)
    return outcome
  }

  async failure({ stage, profile, error, message, advice, source = "manual" }) {
    let image = null
    if (this.render) {
      try {
        image = await this.renderFailure({ stage, profile, error, message, advice })
      } catch (renderError) {
        globalThis.logger?.warn?.(`[Lotus-Plugin] signin failure render failed: ${renderError.message}`)
      }
    }
    const outcome = {
      ok: false,
      stage,
      source,
      profile,
      error,
      image,
      message: error.message || message,
    }
    await this.audit(outcome)
    return outcome
  }

  async audit(outcome) {
    try {
      await this.appendAudit(outcome)
    } catch (error) {
      globalThis.logger?.warn?.(`[Lotus-Plugin] checkin audit failed: ${error.message}`)
    }
  }
}

async function runSigninWithTimeout(runner, profile, options) {
  const supplied = Number(options.timeoutMs)
  const timeoutMs = Number.isFinite(supplied) && supplied > 0 ? supplied : 20 * 60 * 1000
  const controller = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Signin runner timed out after ${timeoutMs}ms`)
      error.code = "LOTUS_RUNNER_TIMEOUT"
      error.timeoutMs = timeoutMs
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  const beforeRequest = async context => {
    controller.signal.throwIfAborted()
    await options.beforeRequest?.(context)
    controller.signal.throwIfAborted()
  }
  try {
    return await Promise.race([
      Promise.resolve().then(() => runner.runProfile(profile, { ...options, timeoutMs, signal: controller.signal, beforeRequest })),
      timeout,
    ])
  } finally { clearTimeout(timer) }
}

export async function renderSigninResult({ result, profile, skipped }) {
  const detail = String(result.message || "")
  const message = result.ok
    ? detail.split(/\r\n?|\n/).map(line => line.trim()).filter(line => line.includes("米游币")).join("\n")
    : (detail || "无详细结果").slice(0, 180)

  return renderTemplate("checkin-result", {
    title: profile.user?.nickname || `QQ ${profile.user?.qq || ""}`,
    subtitle: `profile ${profile.profile?.id || 1}`,
    badge: result.ok ? "米游币" : "失败",
    message,
    avatar: qqAvatar(profile.user?.qq),
    userId: profile.user?.qq,
    games: buildSigninRows(profile, result, skipped),
  }, {
    saveId: `lotus-checkin-${profile.user?.qq || "user"}-${profile.profile?.id || 1}`,
  })
}

export async function renderSigninFailure({ stage, profile, error, message, advice }) {
  const userId = profile?.user?.qq || ""
  const profileId = profile?.profile?.id || 1
  return renderTemplate("checkin-result", {
    title: profile?.user?.nickname || `QQ ${userId}`,
    subtitle: `profile ${profileId}`,
    badge: "失败",
    message: `${message} ${error?.message || ""} ${advice || ""}`.trim(),
    avatar: qqAvatar(userId),
    userId,
    games: buildSigninRows(profile || {}, { ok: false }, collectSkipped(profile || {})),
  }, {
    saveId: `lotus-checkin-error-${userId || "user"}-${profileId}`,
  })
}

export function prepareRunnableProfile(profile) {
  const copy = structuredClone(profile)
  if (copy.mihoyobbs?.enable && !(copy.device?.id && copy.device?.fp)) {
    copy.mihoyobbs.enable = false
  }
  return copy
}

export function collectSkipped(profile) {
  const skipped = []
  if (profile.mihoyobbs?.enable && !(profile.device?.id && profile.device?.fp)) {
    skipped.push("社区任务需要配对的设备 ID 和 FP，本次仅跳过社区任务；自动设备会继续补全 FP，也可绑定真机。")
  }
  return skipped
}

const SIGNIN_GAMES = [
  { key: "genshin", label: "原神", forumId: 2 },
  { key: "honkai2", label: "崩坏2", forumId: 3 },
  { key: "honkai3rd", label: "崩坏3", forumId: 1 },
  { key: "tears_of_themis", label: "未定事件簿", forumId: 4 },
  { key: "villa", label: "大别野", forumId: 5, communityOnly: true },
  { key: "honkai_sr", label: "星铁", forumId: 6 },
  { key: "zzz", label: "绝区零", forumId: 8 },
  { key: "hna", label: "因缘精灵", forumId: 9 },
  { key: "starry", label: "星布谷地", forumId: 10, communityOnly: true },
]

function buildSigninRows(profile, result, skipped = []) {
  const games = profile.games?.cn || {}
  const status = (kind, key) => {
    const rows = (result.tasks || []).filter(row => row.kind === kind && row.key === key)
    if (!rows.length) return "未执行"
    if (rows.some(row => row.status === "failed")) return "失败"
    if (rows.every(row => row.status === "skipped")) return "跳过"
    return rows.every(row => row.status === "already") ? "已完成" : "成功"
  }
  const bbs = profile.mihoyobbs || {}
  const communityEnabled = Boolean(bbs.enable && (bbs.tasks?.checkin ?? bbs.checkin ?? true))
  const missingDevice = skipped.some(text => String(text).includes("设备"))
  return SIGNIN_GAMES.map(game => {
    const gameEnabled = !game.communityOnly && games.enable !== false && games[game.key]?.checkin === true
    const forumEnabled = communityEnabled && bbs.checkin_list?.map?.(Number).includes(game.forumId)
    return {
      label: game.label,
      game: game.communityOnly ? "无" : gameEnabled ? status("game", game.key) : "关闭",
      community: forumEnabled ? (missingDevice ? "跳过" : status("community", String(game.forumId))) : "关闭",
    }
  })
}

function qqAvatar(qq) {
  const id = String(qq || "1102305070")
  return `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=640`
}
