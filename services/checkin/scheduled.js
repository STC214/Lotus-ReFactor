import { loadGlobalConfig } from "../../core/config/global.js"
import { createCaptchaEventReporter } from "../../core/captcha/notify.js"
import { listAllProfiles, loadProfile } from "../../core/config/profile.js"
import { renderTemplate } from "../../core/render/service.js"
import { SchedulerService, dateString, nextDateString, normalizeSchedulerConfig, planDateForGeneration } from "../../core/scheduler/service.js"
import { formatLocalIso } from "../../core/time.js"
import { notifyProfile } from "../../core/transport/notify.js"
import { communityForumName } from "../miyoushe/tasks.js"
import { ProfileSigninService, renderSigninFailure } from "./profileSignin.js"

const taskState = globalThis[Symbol.for("lotus-plugin.scheduled-signin-tasks")] ||= { schedules: new Map(), plans: new Map() }
const scheduleTasks = taskState.schedules
const planTasks = taskState.plans
const COMMUNITY_RETRY_DELAYS = [10, 60, 180].map(minutes => minutes * 60_000)
const COMMUNITY_RETRY_FALLBACK_DELAY = 6 * 60 * 60_000
export const COMMUNITY_RETRY_FINAL_CRON = "0 50,59 23 * * ? *"

export class ScheduledSigninService {
  constructor(options = {}) {
    this.scheduler = options.scheduler || new SchedulerService(options)
    this.signin = options.signin || new ProfileSigninService(options)
    this.notify = options.notify || notifyProfile
    this.loadProfile = options.loadProfile || loadProfile
    this.bot = options.bot
    this.now = options.now || (() => new Date())
    this.renderTemplate = options.renderTemplate || renderTemplate
  }

  async runDue(options = {}) {
    const now = options.now || this.now()
    const planDate = options.date || dateString(now)
    const task = options.communityRetriesOnly ? "community-retries" : "run-due"
    return runScheduleTask(`${task}:${planDate}`, () => runPlanTask(planDate, () => this.runDuePlan(planDate, now, options)))
  }

  async runAll(options = {}) {
    const now = options.now || this.now()
    const planDate = options.date || dateString(now)
    return runScheduleTask(`run-all:${planDate}`, () => runPlanTask(planDate, () => this.runAllProfiles(planDate, now, options)))
  }

  async runAllProfiles(planDate, now, options = {}) {
    const config = options.config || await loadGlobalConfig()
    const schedulerConfig = normalizeSchedulerConfig(config.scheduler || this.scheduler.config || {})
    const suppliedProfiles = options.profiles || await listAllProfiles()
    const profiles = suppliedProfiles.filter(profile => profile?.enabled === true)
    let plan = await this.scheduler.getPlan(planDate)
    const createdPlan = !plan
    if (!plan) plan = await this.scheduler.getOrCreatePlan(planDate, { profiles })

    const results = []
    for (const profile of profiles) {
      const qq = String(profile.user?.qq || "")
      const profileId = Number(profile.profile?.id || 1)
      let entry = plan.entries.find(item => item.qq === qq && Number(item.profileId) === profileId)
      if (!entry) {
        entry = {
          qq,
          profileId,
          name: profile.profile?.name || "",
          time: formatPlanMinute(now),
          mode: "catch_up",
          notified: true,
          done: false,
        }
        plan.entries.push(entry)
      }

      const startedAt = options.now || this.now()
      entry.attemptsBeforeManualCatchUp = Number(entry.attempts || 0)
      entry.attempts = 1
      entry.runningAt = formatLocalIso(startedAt)
      entry.lastAttemptAt = entry.runningAt
      delete entry.nextRetryAt
      delete entry.communityRetry
      await this.scheduler.savePlan(plan)

      const outcome = await this.runEntry(entry, {
        ...options,
        notify: false,
        source: "catch_up_all",
        profile,
        timeoutMs: Number(config.scheduler?.entry_timeout_minutes || 20) * 60 * 1000,
      })
      entry.ok = outcome.ok
      entry.stage = outcome.stage
      entry.message = outcome.message || outcome.error?.message || ""
      const completedAt = options.now || this.now()
      entry.manualCatchUpAt = formatLocalIso(completedAt)
      delete entry.runningAt
      delete entry.notificationRetryAt
      delete entry.notificationExhaustedAt
      delete entry.resultNotified
      const retryDelay = !outcome.ok && isRetryableOutcome(outcome)
        && !(outcome.result?.retryCommunityForums?.length && !hasOtherFailure(outcome))
        ? schedulerConfig.failure_retry_minutes[0]
        : undefined
      const retryAt = Number.isFinite(retryDelay)
        ? new Date(completedAt.getTime() + retryDelay * 60 * 1000)
        : null
      if (retryAt && dateString(retryAt) === planDate) {
        entry.done = false
        entry.nextRetryAt = formatLocalIso(retryAt)
        delete entry.doneAt
      } else {
        entry.done = true
        entry.doneAt = entry.manualCatchUpAt
        delete entry.nextRetryAt
      }
      updateCommunityRetry(entry, outcome, completedAt, planDate)
      await this.scheduler.savePlan(plan)
      const resultItem = { entry: { ...entry }, outcome }
      results.push(resultItem)
      if (typeof options.onResult === "function") {
        try {
          await options.onResult({
            ...resultItem,
            index: results.length,
            total: profiles.length,
          })
        } catch (error) {
          globalThis.logger?.warn?.(`[Lotus-Plugin] all catch-up result reply failed for ${qq}/P${profileId}: ${error.message}`)
        }
      }
    }

    plan.entries.sort((a, b) => a.time.localeCompare(b.time) || a.qq.localeCompare(b.qq) || a.profileId - b.profileId)
    await this.scheduler.savePlan(plan)
    return {
      ok: results.every(item => item.outcome.ok),
      date: planDate,
      count: results.length,
      success: results.filter(item => item.outcome.ok).length,
      failed: results.filter(item => !item.outcome.ok).length,
      skipped: suppliedProfiles.length - profiles.length,
      results,
      createdPlan,
    }
  }

  async runDuePlan(planDate, now, options = {}) {
    const config = options.config || await loadGlobalConfig()
    const schedulerConfig = normalizeSchedulerConfig(config.scheduler || this.scheduler.config || {})
    let plan = await this.scheduler.getPlan(planDate)
    if (!plan) {
      return {
        ok: true,
        date: planDate,
        count: 0,
        results: [],
        createdPlan: false,
        recovered: 0,
        notificationRetries: [],
        skipped: true,
        reason: "plan_not_found",
      }
    }
    const recoveredEntries = recoverStaleRunningEntries(plan, now, schedulerConfig.running_timeout_minutes)
    if (recoveredEntries.length) {
      await this.scheduler.savePlan(plan)
      globalThis.logger?.warn?.(`[Lotus-Plugin] recovered ${recoveredEntries.length} stale scheduled checkin entr${recoveredEntries.length === 1 ? "y" : "ies"}`)
    }
    const notificationRetries = options.notify === false
      ? []
      : await this.retryResultNotifications(plan, now, schedulerConfig, options)
    const dueEntries = plan.entries.filter(entry => options.communityRetriesOnly
      ? !entry.done && !entry.runningAt && entry.communityRetry && Date.parse(entry.communityRetry.nextAt) <= now.getTime()
      : isDue(entry, now))
    const results = []
    for (const entry of dueEntries) {
      const previous = entry.communityRetry
      const communityOnly = Boolean(previous && Date.parse(previous.nextAt) <= now.getTime()
        && (options.communityRetriesOnly || !entry.nextRetryAt || Date.parse(previous.nextAt) <= Date.parse(entry.nextRetryAt)))
      const startedAt = options.now || this.now()
      if (dateString(startedAt) !== planDate) break
      if (!communityOnly) entry.attempts = Number(entry.attempts || 0) + 1
      entry.runningAt = formatLocalIso(now)
      entry.lastAttemptAt = entry.runningAt
      if (!communityOnly) delete entry.nextRetryAt
      await this.scheduler.savePlan(plan)
      const outcome = await this.runEntry(entry, {
        ...options,
        timeoutMs: schedulerConfig.entry_timeout_minutes * 60 * 1000,
        communityRetryForums: communityOnly ? previous.forums : undefined,
        retrySignal: communityOnly ? AbortSignal.timeout(Math.max(1, new Date(startedAt).setHours(24, 0, 0, 0) - startedAt.getTime())) : undefined,
      })
      entry.ok = outcome.ok
      entry.stage = outcome.stage
      entry.message = outcome.message || outcome.error?.message || ""
      delete entry.runningAt
      const retryDelay = !communityOnly && !outcome.ok && isRetryableOutcome(outcome)
        && !(outcome.result?.retryCommunityForums?.length && !hasOtherFailure(outcome))
        ? schedulerConfig.failure_retry_minutes[entry.attempts - 1]
        : undefined
      const retryAt = Number.isFinite(retryDelay)
        ? new Date(now.getTime() + retryDelay * 60 * 1000)
        : null
      if (communityOnly) {
        entry.done = !entry.nextRetryAt
      } else if (retryAt && dateString(retryAt) === planDate) {
        entry.done = false
        entry.nextRetryAt = formatLocalIso(retryAt)
      } else {
        entry.done = true
        entry.doneAt = formatLocalIso(now)
        delete entry.nextRetryAt
      }
      updateCommunityRetry(entry, outcome, options.now || this.now(), planDate, communityOnly ? previous : undefined)
      if (communityOnly) {
        const attempts = previous.attempts + 1
        entry.message = `${previous.initialMessage}\n社区签到补跑第 ${attempts} 次：${entry.message || "本轮未完成"}`
        if (options.notify !== false && outcome.profile) {
          const next = entry.communityRetry ? `\n预计 ${formatLocalIso(new Date(entry.communityRetry.nextAt)).slice(11, 16)} 后再试。` : "\n今日自动补跑已结束。"
          try {
            outcome.notification = await this.notify(outcome.profile,
              `[荷花插件]社区签到补跑第 ${attempts} 次（Profile ${entry.profileId}）\n本轮只补签：${previous.forums.map(communityForumName).join("、")}。游戏签到结果以首轮为准。\n${entry.message}${next}`, { bot: options.bot || this.bot })
          } catch (error) { outcome.notification = { ok: false, reason: error.message } }
        }
      }
      updateResultNotificationState(entry, outcome, now, schedulerConfig, options)
      await this.scheduler.savePlan(plan)
      results.push({ entry: { ...entry }, outcome })
    }
    return {
      ok: results.every(item => item.entry.ok),
      date: planDate,
      count: results.length,
      results,
      createdPlan: false,
      recovered: recoveredEntries.length,
      notificationRetries,
    }
  }

  async retryResultNotifications(plan, now, schedulerConfig, options = {}) {
    const results = []
    for (const entry of plan.entries || []) {
      if (!isResultNotificationDue(entry, now)) continue
      const profile = await this.loadProfile(entry.qq, entry.profileId).catch(() => null)
      const attempt = Number(entry.notificationAttempts || 1) + 1
      entry.notificationAttempts = attempt
      let sent
      try {
        if (!profile) throw new Error("profile not found")
        sent = await this.notify(profile, scheduledResultText(entry), { bot: options.bot || this.bot })
      } catch (error) {
        sent = { ok: false, reason: error.message, error }
      }
      entry.resultNotified = Boolean(sent?.ok)
      entry.lastNotificationAt = formatLocalIso(now)
      if (entry.resultNotified) {
        delete entry.notificationRetryAt
      } else {
        const delay = schedulerConfig.failure_retry_minutes[attempt - 1]
        const retryAt = Number.isFinite(delay) ? new Date(now.getTime() + delay * 60 * 1000) : null
        if (retryAt && dateString(retryAt) === plan.date) {
          entry.notificationRetryAt = formatLocalIso(retryAt)
        } else {
          delete entry.notificationRetryAt
          entry.notificationExhaustedAt = formatLocalIso(now)
        }
      }
      results.push({ entry: { ...entry }, sent })
    }
    if (results.length) await this.scheduler.savePlan(plan)
    return results
  }

  async notifyPlan(plan, options = {}) {
    const results = []
    for (const entry of plan.entries) {
      if (entry.notified && !options.force) continue
      const profile = await this.loadProfile(entry.qq, entry.profileId).catch(() => null)
      if (!profile) continue
      try {
        const image = await this.renderTemplate("schedule-notice", {
          title: profile.user?.nickname || `QQ ${entry.qq}`,
          subtitle: `${plan.date} · profile ${entry.profileId}`,
          badge: entry.mode,
          message: `明日自动签到将在 ${entry.time} 左右执行。`,
          avatar: qqAvatar(entry.qq),
          userId: entry.qq,
          items: [
            { label: "签到时间", value: entry.time },
            { label: "模式", value: entry.mode },
            { label: "日期", value: plan.date },
          ],
        }, { saveId: `lotus-schedule-notice-${entry.qq}-${entry.profileId}` })
        const sent = await this.notify(profile, image, { bot: options.bot || this.bot })
        entry.notified = sent.ok
        results.push({ entry: { ...entry }, sent })
      } catch (error) {
        entry.notified = false
        results.push({ entry: { ...entry }, sent: { ok: false, reason: error.message, error } })
        globalThis.logger?.warn?.(`[Lotus-Plugin] schedule notice failed for ${entry.qq}/P${entry.profileId}: ${error.message}`)
      }
    }
    await this.scheduler.savePlan(plan)
    return results
  }

  async ensurePlanAndNotify(options = {}) {
    const config = options.config || await loadGlobalConfig()
    const now = options.now || this.now()
    const date = options.date || planDateForGeneration(
      now,
      config.scheduler?.plan_generate_cron,
      config.scheduler?.plan_date_cutoff_time,
    )
    return runScheduleTask(`tomorrow-plan:${date}`, () => runPlanTask(date, async () => {
      const plan = await this.scheduler.getOrCreatePlan(date, {
        force: options.force,
        reconcile: true,
      })
      const shouldNotify = options.forceNotify || config.scheduler?.random?.notify_before !== false
      const notifications = shouldNotify ? await this.notifyPlan(plan, options) : []
      return { plan, notifications }
    }))
  }

  async ensureTomorrowPlanAndNotify(options = {}) {
    return this.ensurePlanAndNotify(options)
  }

  async addLateProfileAndNotify(profile, options = {}) {
    const config = options.config || await loadGlobalConfig()
    const now = options.now || this.now()
    const dates = options.dates || [dateString(now), nextDateString(now)]
    const results = []
    for (const date of dates) {
      const items = await runPlanTask(date, () => this.scheduler.addLateProfileToExistingPlans(profile, {
        ...options,
        now,
        dates: [date],
      }))
      results.push(...items)
    }
    const added = results.filter(item => item.ok && !item.skipped && item.entry)
    if (!added.length || config.scheduler?.late_registration?.notify === false || options.notify === false) {
      return { results, notifications: [] }
    }
    const notifications = []
    for (const item of added) {
      const image = await this.renderTemplate("schedule-notice", {
        title: profile.user?.nickname || `QQ ${profile.user?.qq || ""}`,
        subtitle: `${item.date} · profile ${profile.profile?.id || 1}`,
        badge: "补入",
        message: `已加入${item.date === dateString(now) ? "今日" : "明日"}补位计划，将在 ${item.entry.time} 左右执行。`,
        avatar: qqAvatar(profile.user?.qq),
        userId: profile.user?.qq,
        items: [
          { label: "签到时间", value: item.entry.time },
          { label: "模式", value: "新注册补位" },
          { label: "日期", value: item.date },
        ],
      }, { saveId: `lotus-late-schedule-${profile.user?.qq || "user"}-${profile.profile?.id || 1}-${item.date}` })
      notifications.push(await this.notify(profile, image, { bot: options.bot || this.bot }))
    }
    return { results, notifications }
  }

  async runEntry(entry, options = {}) {
    let profile = options.profile || await this.loadProfile(entry.qq, entry.profileId).catch(() => null)
    try {
      const captchaReporter = createCaptchaEventReporter({
        send: async message => {
          if (!profile) return false
          const result = await this.notify(profile, message, { bot: options.bot || this.bot })
          return result.ok
        },
        sendForward: async messages => {
          if (!profile) return false
          const result = await this.notify(profile, messages.join("\n"), { bot: options.bot || this.bot })
          return result.ok
        },
      })
      const outcome = await this.signin.run({
        qq: entry.qq,
        profileId: entry.profileId,
        profile,
        refresh: true,
        source: options.communityRetryForums ? "scheduled_community_retry" : options.source || "scheduled",
        timeoutMs: options.timeoutMs,
        installRequirements: false,
        communityRetryForums: options.communityRetryForums,
        signal: options.retrySignal,
        onCaptchaEvent: async event => {
          await captchaReporter(event).catch(error => {
            globalThis.logger?.warn?.(`[Lotus-Plugin] captcha notify failed: ${error.message}`)
          })
        },
      })
      profile = outcome.profile || profile
      if (options.communityRetryForums) return { ...outcome, profile }
      if (options.notify !== false && profile) {
        try {
          outcome.notification = await this.notify(profile, outcome.image || outcome.message, { bot: options.bot || this.bot })
        } catch (error) {
          outcome.notification = { ok: false, reason: error.message, error }
          globalThis.logger?.warn?.(`[Lotus-Plugin] scheduled signin result notify failed: ${error.message}`)
        }
      }
      return outcome
    } catch (error) {
      const fallbackProfile = profile || {
        user: { qq: entry.qq },
        profile: { id: entry.profileId, notify: { prefer: "private", fallback_groups: [] } },
      }
      let image = null
      try {
        if (!options.communityRetryForums) image = await renderSigninFailure({
          stage: "schedule",
          profile: fallbackProfile,
          error,
          message: "计划签到执行失败。",
          advice: "检查 profile 配置文件是否存在，并确认签到环境已经初始化。",
        })
      } catch (renderError) {
        globalThis.logger?.warn?.(`[Lotus-Plugin] scheduled signin failure render failed: ${renderError.message}`)
      }
      if (!options.communityRetryForums && options.notify !== false) {
        const notification = await this.notify(fallbackProfile, image || `[荷花插件]计划签到失败：${error.message}`, { bot: options.bot || this.bot }).catch(notifyError => {
          globalThis.logger?.warn?.(`[Lotus-Plugin] scheduled signin notify failed: ${notifyError.message}`)
          return { ok: false, reason: notifyError.message, error: notifyError }
        })
        return {
          ok: false,
          stage: "schedule",
          profile: fallbackProfile,
          error,
          image,
          notification,
          message: error.message,
        }
      }
      return {
        ok: false,
        stage: "schedule",
        profile: fallbackProfile,
        error,
        image,
        message: error.message,
      }
    }
  }
}

function qqAvatar(qq) {
  const id = String(qq || "1102305070")
  return `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=640`
}

function isDue(entry, now) {
  if (entry.done || entry.runningAt) return false
  if (entry.communityRetry && Date.parse(entry.communityRetry.nextAt) <= now.getTime()) return true
  if (entry.nextRetryAt) {
    const retryAt = new Date(entry.nextRetryAt)
    if (!Number.isNaN(retryAt.getTime())) return retryAt.getTime() <= now.getTime()
  }
  return !entry.communityRetry && timeToMinute(entry.time) <= now.getHours() * 60 + now.getMinutes()
}

function hasOtherFailure(outcome) {
  return (outcome.result?.tasks || []).some(row => ["failed", "unverified"].includes(row.status)
    && (!["community", "missions"].includes(row.kind) || !row.retryable))
}

function updateCommunityRetry(entry, outcome, now, planDate, previous) {
  const forums = outcome.result?.retryCommunityForums
    || (previous && ["refresh", "runner", "timeout", "schedule"].includes(outcome.stage) ? previous.forums : [])
  const attempts = previous ? previous.attempts + 1 : 0
  const cutoff = new Date(now).setHours(23, 50, 0, 0)
  const finalRetry = previous && now.getTime() >= cutoff
  const delay = COMMUNITY_RETRY_DELAYS[attempts] ?? COMMUNITY_RETRY_FALLBACK_DELAY
  const nextAt = now.getTime() < cutoff ? Math.min(now.getTime() + delay, cutoff) : new Date(now).setHours(23, 59, 0, 0)
  const otherFailure = Boolean(previous?.otherFailure || hasOtherFailure(outcome))
  if (forums.length && !finalRetry && dateString(now) === planDate && nextAt > now.getTime()) {
    entry.communityRetry = { forums, attempts, nextAt: new Date(nextAt).toISOString(), otherFailure,
      initialMessage: previous?.initialMessage ?? entry.message }
    entry.done = false
  } else {
    delete entry.communityRetry
  }
  if (previous) {
    const tasks = outcome.result?.tasks || []
    const retriedAll = previous.forums.every(id => tasks.some(row => row.kind === "community" && row.key === id && ["success", "already"].includes(row.status)))
    entry.ok = Boolean(outcome.ok && retriedAll && !otherFailure)
  }
  if (entry.done) entry.doneAt = formatLocalIso(now)
  else delete entry.doneAt
}

function recoverStaleRunningEntries(plan, now, timeoutMinutes) {
  const recovered = []
  const cutoff = now.getTime() - timeoutMinutes * 60 * 1000
  for (const entry of plan.entries || []) {
    if (!entry.runningAt || entry.done) continue
    const runningAt = new Date(entry.runningAt)
    if (!Number.isNaN(runningAt.getTime()) && runningAt.getTime() > cutoff) continue
    delete entry.runningAt
    entry.recoveryCount = Number(entry.recoveryCount || 0) + 1
    entry.recoveredAt = formatLocalIso(now)
    recovered.push(entry)
  }
  return recovered
}

function isRetryableOutcome(outcome = {}) {
  return ["refresh", "checkin", "runner", "schedule", "timeout"].includes(outcome.stage)
}

function updateResultNotificationState(entry, outcome, now, schedulerConfig, options = {}) {
  if (options.notify === false || !outcome.notification) return
  entry.notificationAttempts = 1
  entry.lastNotificationAt = formatLocalIso(now)
  entry.resultNotified = Boolean(outcome.notification.ok)
  if (entry.resultNotified) {
    delete entry.notificationRetryAt
    return
  }
  const delay = schedulerConfig.failure_retry_minutes[0]
  const retryAt = Number.isFinite(delay) ? new Date(now.getTime() + delay * 60 * 1000) : null
  if (retryAt && dateString(retryAt) === dateString(now)) {
    entry.notificationRetryAt = formatLocalIso(retryAt)
  } else {
    entry.notificationExhaustedAt = formatLocalIso(now)
  }
}

function isResultNotificationDue(entry, now) {
  if (!entry.done || entry.resultNotified !== false || !entry.notificationRetryAt) return false
  const retryAt = new Date(entry.notificationRetryAt)
  return !Number.isNaN(retryAt.getTime()) && retryAt.getTime() <= now.getTime()
}

function scheduledResultText(entry) {
  const status = entry.ok ? "成功" : "失败"
  return `[荷花插件]定时签到${status}：QQ ${entry.qq} / Profile ${entry.profileId}；阶段 ${entry.stage || "checkin"}；${entry.message || "无详细信息"}`
}

function timeToMinute(value = "00:00") {
  const match = String(value).match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return Number.POSITIVE_INFINITY
  return Number(match[1]) * 60 + Number(match[2])
}

function formatPlanMinute(date = new Date()) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

async function runScheduleTask(key, task) {
  const current = scheduleTasks.get(key)
  if (current) return current
  const pending = Promise.resolve().then(task)
  scheduleTasks.set(key, pending)
  try {
    return await pending
  } finally {
    if (scheduleTasks.get(key) === pending) scheduleTasks.delete(key)
  }
}

async function runPlanTask(date, task) {
  const key = `plan:${date}`
  const previous = planTasks.get(key) || Promise.resolve()
  let release
  const pending = new Promise(resolve => {
    release = resolve
  })
  planTasks.set(key, pending)
  try {
    await previous.catch(() => {})
    return await task()
  } finally {
    release()
    if (planTasks.get(key) === pending) planTasks.delete(key)
  }
}
