const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"

import { loadGlobalConfig, saveGlobalConfig } from "../core/config/global.js"
import { listProfileIds, loadProfile } from "../core/config/profile.js"
import { PermissionService } from "../core/permissions/service.js"
import { SchedulerService, cronToMinuteOfDay, dateString, planDateForGeneration } from "../core/scheduler/service.js"
import { renderStatusCard } from "../core/render/service.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { ScheduledSigninService } from "../services/checkin/scheduled.js"
import {
  applySchedulerSettings,
  describeSchedulerSettings,
  parseSchedulerSettingsCommand,
} from "../core/scheduler/settings.js"

export class LotusScheduler extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Scheduler",
      dsc: "Lotus checkin schedule plan",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [
        { reg: "^#生成签到计划$", fnc: "generatePlan" },
        { reg: "^#我的签到时间$", fnc: "myPlan" },
        { reg: "^#执行到期签到$", fnc: "runDueCommand" },
        { reg: "^#全部补签$", fnc: "runAllCatchUpCommand" },
        { reg: "^#签到(随机|固定)模式(\\s+\\d{1,2}:\\d{2})?$", fnc: "updateSchedulerSettings" },
        { reg: "^#签到计划生成\\s+\\d{1,2}:\\d{2}$", fnc: "updateSchedulerSettings" },
      ],
    })
    this.task = [
      {
        name: "荷花插件自动签到调度",
        cron: "0 * * * * ? *",
        fnc: this.runDueCheckins.bind(this),
        log: false,
      },
      {
        name: "荷花插件生成签到计划",
        cron: "0 * * * * ? *",
        fnc: this.generateScheduledPlanTask.bind(this),
        log: false,
      },
      {
        name: "荷花插件签到计划补偿检查",
        cron: "0 */10 * * * ? *",
        fnc: this.catchUpTomorrowPlanTask.bind(this),
        log: false,
      },
    ]
  }

  async init() {
    try {
      const globalConfig = await loadGlobalConfig()
      this.task = [
        {
          name: "荷花插件自动签到调度",
          cron: globalConfig.scheduler?.run_due_cron || "0 * * * * ? *",
          fnc: this.runDueCheckins.bind(this),
          log: false,
        },
        {
          name: "荷花插件生成签到计划",
          cron: "0 * * * * ? *",
          fnc: this.generateScheduledPlanTask.bind(this),
          log: false,
        },
        ...(globalConfig.scheduler?.catch_up_cron ? [{
          name: "荷花插件签到计划补偿检查",
          cron: globalConfig.scheduler.catch_up_cron,
          fnc: this.catchUpTomorrowPlanTask.bind(this),
          log: false,
        }] : []),
      ]
      this.scheduleStartupCatchUp(globalConfig)
    } catch (error) {
      logger?.warn?.(`[Lotus-Plugin] load scheduler cron failed, fallback defaults: ${error.message}`)
    }
  }

  async generatePlan() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "scheduler.generate")
    if (!permission.ok) {
      await replyText(this, "[荷花插件]只有 bot 主人可以生成全局签到计划。")
      return true
    }
    const now = new Date()
    const date = planDateForGeneration(now, globalConfig.scheduler?.plan_generate_cron, globalConfig.scheduler?.plan_date_cutoff_time)
    const generated = await new ScheduledSigninService({
      scheduler: new SchedulerService({ config: globalConfig.scheduler }),
    }).ensurePlanAndNotify({
      config: globalConfig,
      date,
      force: true,
      forceNotify: true,
      bot: globalThis.Bot,
    })
    const { plan, notifications } = generated
    const image = await renderSchedulePlan(plan, {
      title: "签到计划",
      subtitle: `${date} · 全局计划`,
      userId: this.e.user_id,
      notifications,
    })
    const dayLabel = date === dateString(now) ? "今日" : "明日"
    await replyImage(this, image, `[荷花插件]${dayLabel}签到计划已生成。`)
    return true
  }

  async myPlan() {
    const globalConfig = await loadGlobalConfig()
    const date = planDateForGeneration(new Date(), globalConfig.scheduler?.plan_generate_cron, globalConfig.scheduler?.plan_date_cutoff_time)
    const scheduler = new SchedulerService({ config: globalConfig.scheduler })
    const userId = String(this.e.user_id)
    await addMissingProfilesToPlan(userId, date, scheduler, globalConfig)
    const plan = await scheduler.getPlan(date)
    if (!plan) {
      await replyText(this, `[荷花插件]${date === dateString() ? "今日" : "明日"}签到计划尚未生成，请等待计划生成任务，或由 bot 主人执行 #生成签到计划。`)
      return true
    }
    const entries = plan.entries.filter(item => item.qq === userId)
    if (!entries.length) {
      await replyText(this, `[荷花插件]${date === dateString() ? "今日" : "明日"}计划里没有找到你的 profile。`)
      return true
    }
    const image = await renderSchedulePlan({ ...plan, entries }, {
      title: "我的签到时间",
      subtitle: `${date} · QQ ${userId}`,
      userId,
    })
    await replyImage(this, image, `[荷花插件]这是你${date === dateString() ? "今日" : "明日"}的签到时间。`)
    return true
  }

  async generateScheduledPlanTask(options = {}) {
    const globalConfig = await loadGlobalConfig()
    const now = new Date()
    const configuredMinute = cronToMinuteOfDay(globalConfig.scheduler?.plan_generate_cron || "")
    const currentMinute = now.getHours() * 60 + now.getMinutes()
    if (!options.force && (!Number.isFinite(configuredMinute) || currentMinute !== configuredMinute)) {
      return {
        ok: true,
        skipped: true,
        reason: Number.isFinite(configuredMinute) ? "not_generation_minute" : "invalid_plan_generate_cron",
        configuredMinute,
        currentMinute,
      }
    }
    const date = planDateForGeneration(now, globalConfig.scheduler?.plan_generate_cron, globalConfig.scheduler?.plan_date_cutoff_time)
    const generated = await new ScheduledSigninService({
      scheduler: new SchedulerService({ config: globalConfig.scheduler }),
    }).ensurePlanAndNotify({
      config: globalConfig,
      date,
      now,
      bot: globalThis.Bot,
    })
    logger?.mark?.(`[Lotus-Plugin] schedule ready: ${generated.plan.date}, notify ${generated.notifications.length}`)
    return generated
  }

  scheduleStartupCatchUp(globalConfig) {
    if (!globalConfig.scheduler?.catch_up_cron) return globalConfig
    setTimeout(() => {
      this.catchUpTomorrowPlanTask({ trigger: "启动补偿" }).catch(error => {
        logger?.error?.(`[Lotus-Plugin] schedule catch-up failed: ${error.stack || error.message}`)
      })
    }, 60 * 1000).unref?.()
    return globalConfig
  }

  async catchUpTomorrowPlanTask(options = {}) {
    const globalConfig = await loadGlobalConfig()
    const now = options.now || new Date()
    const generateMinute = cronToMinuteOfDay(globalConfig.scheduler?.plan_generate_cron || "0 0 0 * * ? *")
    if (!Number.isFinite(generateMinute)) {
      return {
        ok: false,
        skipped: true,
        reason: "invalid_plan_generate_cron",
      }
    }
    const currentMinute = now.getHours() * 60 + now.getMinutes()
    const elapsedMinutes = (currentMinute - generateMinute + 1440) % 1440
    if (elapsedMinutes > 30) {
      return {
        ok: true,
        skipped: true,
        reason: "outside_catch_up_window",
        elapsedMinutes,
      }
    }
    const scheduler = new SchedulerService({ config: globalConfig.scheduler })
    const generationDate = new Date(now.getTime())
    if (currentMinute < generateMinute) generationDate.setDate(generationDate.getDate() - 1)
    const date = planDateForGeneration(
      generationDate,
      globalConfig.scheduler?.plan_generate_cron,
      globalConfig.scheduler?.plan_date_cutoff_time,
    )
    const existing = await scheduler.getPlan(date)
    if (existing) {
      const pendingNotices = existing.entries.filter(entry => !entry.notified).length
      if (pendingNotices && globalConfig.scheduler?.random?.notify_before !== false) {
        return new ScheduledSigninService({ scheduler }).ensurePlanAndNotify({
          config: globalConfig,
          date,
          bot: globalThis.Bot,
        })
      }
      return {
        ok: true,
        skipped: true,
        reason: "plan_exists",
        date,
      }
    }
    logger?.mark?.(`[Lotus-Plugin] schedule catch-up creating plan: ${date}`)
    return this.generateScheduledPlanTask({ trigger: options.trigger || "补偿检查" })
  }

  async runDueCommand() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "scheduler.run_due")
    if (!permission.ok) {
      await replyText(this, "[荷花插件]只有 bot 主人可以执行到期签到。")
      return true
    }
    await replyText(this, "[荷花插件]正在检查并执行到期签到任务。")
    const result = await this.runDueCheckins({ notify: true })
    const image = await renderStatusCard({
      title: "到期签到",
      subtitle: result.date,
      badge: String(result.count),
      message: result.count ? "已执行所有到期且未完成的签到任务，结果会分别通知对应用户。" : "当前没有到期且未完成的签到任务。",
      userId: this.e.user_id,
      items: result.results.slice(0, 8).map(({ entry, outcome }) => ({
        label: `QQ ${entry.qq} · P${entry.profileId}`,
        value: `${outcome.ok ? "成功" : "失败"} · ${outcome.stage}`,
      })),
    }, {
      saveId: `lotus-run-due-${this.e.user_id || "master"}`,
    })
    await replyImage(this, image, "[荷花插件]到期签到检查完成。")
    return true
  }

  async runAllCatchUpCommand() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "scheduler.run_due")
    if (!permission.ok) {
      await replyText(this, "[荷花插件]只有 bot 主人可以执行全部补签。")
      return true
    }

    await replyText(this, "[荷花插件]正在为所有已启用的 Profile 检查并补签，请稍候。")
    const scheduler = new SchedulerService({ config: globalConfig.scheduler })
    const result = await new ScheduledSigninService({ scheduler }).runAll({
      config: globalConfig,
      date: dateString(),
      bot: globalThis.Bot,
      onResult: async ({ entry, outcome, index, total }) => {
        const state = outcome.ok ? "完成" : "失败"
        const fallback = outcome.ok
          ? `[荷花插件]全部补签 ${index}/${total}：QQ ${entry.qq} · Profile ${entry.profileId} 签到完成。`
          : `[荷花插件]全部补签 ${index}/${total}：QQ ${entry.qq} · Profile ${entry.profileId} 签到失败：${outcome.message || outcome.error?.message || "未知错误"}`
        await replyImage(this, outcome.image, fallback)
        globalThis.logger?.info?.(`[Lotus-Plugin] all catch-up ${index}/${total} ${entry.qq}/P${entry.profileId}: ${state}`)
      },
    })
    const image = await renderStatusCard({
      title: "全部补签",
      subtitle: result.date,
      badge: `${result.success}/${result.count}`,
      message: result.count
        ? `已检查 ${result.count} 个启用的 Profile：成功 ${result.success} 个，失败 ${result.failed} 个。已同步更新今日签到计划。`
        : "当前没有已启用的 Profile。",
      userId: this.e.user_id,
      items: [
        ...result.results.slice(0, 12).map(({ entry, outcome }) => ({
          label: `QQ ${entry.qq} · P${entry.profileId}`,
          value: `${outcome.ok ? "成功" : entry.nextRetryAt ? "失败·待重试" : "失败"} · ${outcome.stage || "checkin"}`,
        })),
        ...(result.results.length > 12 ? [{
          label: "更多",
          value: `另有 ${result.results.length - 12} 个 Profile，完整结果已写入签到审计和今日计划。`,
        }] : []),
      ],
    }, {
      saveId: `lotus-catch-up-all-${this.e.user_id || "master"}`,
    })
    await replyImage(this, image, `[荷花插件]全部补签完成：成功 ${result.success}，失败 ${result.failed}。`)
    return true
  }

  async updateSchedulerSettings() {
    const globalConfig = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: globalConfig.permissions })
      .explain(this.e, "scheduler.manage")
    if (!permission.ok) {
      await replyText(this, "[荷花插件]只有 bot 主人可以修改全局签到调度。")
      return true
    }
    const command = parseSchedulerSettingsCommand(this.e.msg)
    if (!command.ok) {
      await replyText(this, `[荷花插件]调度指令无法识别：${command.reason}`)
      return true
    }
    const next = applySchedulerSettings(globalConfig, command)
    await saveGlobalConfig(next)
    const image = await renderStatusCard({
      title: "调度配置",
      subtitle: "荷花插件调度",
      badge: "已保存",
      message: describeSchedulerSettings(command, next),
      userId: this.e.user_id,
      items: [
        { label: "模式", value: next.scheduler.mode },
        { label: "固定时间", value: next.scheduler.fixed_time },
        { label: "计划生成", value: next.scheduler.plan_generate_cron },
        { label: "到期扫描", value: next.scheduler.run_due_cron },
      ],
    }, {
      saveId: `lotus-scheduler-settings-${this.e.user_id || "master"}`,
    })
    await replyImage(this, image, "[荷花插件]调度配置已更新。")
    return true
  }

  async runDueCheckins(options = {}) {
    const globalConfig = await loadGlobalConfig()
    const result = await new ScheduledSigninService({
      scheduler: new SchedulerService({ config: globalConfig.scheduler }),
    }).runDue({ ...options, config: globalConfig })
    if (result.count) {
      logger?.mark?.(`[Lotus-Plugin] scheduled checkin executed: ${result.count}`)
    }
    return result
  }
}

async function addMissingProfilesToPlan(userId, date, scheduler, globalConfig) {
  const profileIds = await listProfileIds(userId)
  if (!profileIds.length) return []
  const service = new ScheduledSigninService({ scheduler })
  const results = []
  for (const profileId of profileIds) {
    const profile = await loadProfile(userId, profileId).catch(() => null)
    if (!profile) continue
    results.push(await service.addLateProfileAndNotify(profile, {
      config: globalConfig,
      dates: [date],
      bot: globalThis.Bot,
    }))
  }
  return results
}

async function renderSchedulePlan(plan, meta) {
  const items = plan.entries.slice(0, 12).map(entry => ({
    label: `Profile ${entry.profileId}`,
    value: `${entry.time} · ${entry.mode}`,
  }))
  if (plan.entries.length > 12) {
    items.push({
      label: "更多",
      value: `另有 ${plan.entries.length - 12} 个 profile`,
    })
  }
  if (meta.notifications?.length) {
    const ok = meta.notifications.filter(item => item.sent?.ok).length
    items.push({
      label: "已通知",
      value: `${ok}/${meta.notifications.length}`,
    })
  }
  return renderStatusCard({
    title: meta.title,
    subtitle: meta.subtitle,
    badge: `${plan.entries.length}`,
    message: plan.mode === "random" ? "随机模式已按时间窗口均匀分布，重启会复用已生成计划。" : "固定模式计划已生成，允许用户级随机的 profile 会单独分布。",
    userId: meta.userId,
    items,
  }, {
    saveId: `lotus-schedule-${meta.userId || "system"}`,
  })
}
