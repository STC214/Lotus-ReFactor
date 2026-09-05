const BasePlugin = globalThis.plugin

import { LOTUS_INTERCEPT_PRIORITY } from "../core/intercept/priority.js"

import { loadGlobalConfig } from "../core/config/global.js"
import { PermissionService } from "../core/permissions/service.js"
import { renderStatusCard } from "../core/render/service.js"
import { ensureBackgroundPool } from "../core/render/background.js"
import { replyImage, replyText } from "../core/transport/reply.js"
import { PythonEnvService } from "../services/python/env.js"
import { TestNineEnvService } from "../services/testNine/env.js"
import { ToolInstallerService } from "../services/tools/installer.js"
import { AtlasUpdateService } from "../services/nanokaAtlas/update.js"
import { buildInitializationSummaryItems, formatNetworkReport, runLotusBootstrap, withInitializationLock } from "../scripts/initialize-lotus.mjs"

let activeInitialization = null

export class LotusInitializer extends BasePlugin {
  constructor() {
    super({
      name: "[Lotus-Plugin] Initializer",
      dsc: "One-command full Lotus initialization",
      event: "message",
      priority: LOTUS_INTERCEPT_PRIORITY,
      rule: [{ reg: "^#初始化荷花$", fnc: "initializeLotus" }],
    })
  }

  async initializeLotus() {
    const config = await loadGlobalConfig()
    const permission = new PermissionService({ permissions: config.permissions })
    if (!permission.isMaster(this.e)) {
      await replyText(this, "[荷花插件]只有 bot 主人可以执行 #初始化荷花。")
      return true
    }
    if (activeInitialization) {
      await replyText(this, "[荷花插件]已有一项完整初始化正在运行，请等待当前任务结束。")
      return true
    }

    activeInitialization = withInitializationLock(() => this.runInitialization(config))
    try {
      await activeInitialization
    } catch (error) {
      globalThis.logger?.error?.(`[Lotus-Plugin] full initialization aborted: ${error.stack || error.message}`)
      await replyText(this, `[荷花插件]完整初始化异常结束：${error.message}。已完成的文件和依赖会保留，可修复网络或环境后重新执行 #初始化荷花。`)
    } finally {
      activeInitialization = null
    }
    return true
  }

  async runInitialization(config) {
    await replyText(this, "[荷花插件]开始完整初始化。第一步将检测各依赖站点的 HTTP Ping，随后按运行手册自动部署。")
    const bootstrap = await runLotusBootstrap({
      onEvent: async event => {
        if (event.type === "network") {
          await replyText(this, formatNetworkReport(event.items))
        } else if (event.type === "stage" && event.state === "end") {
          await replyText(this, `[荷花插件]${event.ok ? "✓" : "✗"} ${event.name}：${event.value || "完成"}`)
        }
      },
    })

    const runtime = []
    const runRuntime = async (name, task) => {
      await replyText(this, `[荷花插件]开始：${name}`)
      const result = await runtimeStep(name, task)
      runtime.push(result)
      await replyText(this, `[荷花插件]${result.ok ? "✓" : "✗"} ${name}：${result.value}`)
    }
    if (bootstrap.ok) await runRuntime("Python / MihoyoBBSTools", async () => {
      const result = await new PythonEnvService({ config: config.python }).ensureVenv({ installRequirements: true })
      return `${result.version || result.mode} · ${result.command}`
    })
    if (bootstrap.ok) await runRuntime("test_nine / 模型", async () => {
      const result = await new TestNineEnvService({ config: config.captcha?.test_nine, pythonConfig: config.python }).ensureEnv()
      if (!result.ok) throw new Error(result.reason || "test_nine 初始化失败")
      return `模型 ${result.models?.items?.filter(item => item.ok).length || 0}/${result.models?.items?.length || 0}`
    })
    if (bootstrap.ok) await runRuntime("BBDown / ffmpeg / aria2", async () => {
      const result = await new ToolInstallerService({ config: config.tools }).ensureAll()
      if (!result.ok) throw new Error((result.items || []).filter(item => !item.ok).map(item => `${item.name}:${item.reason}`).join(" / "))
      return (result.items || []).map(item => item.name).join(" / ")
    })
    if (bootstrap.ok) await runRuntime("本地背景池", async () => {
      const files = await ensureBackgroundPool(config, { cleanupExisting: true })
      return `${files.length} 张本地背景`
    })
    if (bootstrap.ok) await runRuntime("完整图鉴", async () => {
      const result = await new AtlasUpdateService().checkAndRun(config.atlas || {})
      if (!result.ok) throw new Error(result.reason || result.stderr || "图鉴初始化失败")
      return result.skipped ? `已是最新 · ${result.reason || "skip"}` : `${result.mode} · exit ${result.code}`
    })

    const ok = bootstrap.ok && runtime.every(item => item.ok)
    const image = await renderStatusCard({
      title: "荷花完整初始化",
      subtitle: `${process.platform}/${process.arch} · Node ${process.version}`,
      badge: ok ? "完成" : "部分失败",
      message: ok
        ? "系统组件、工作区、原生模块、Python、验证码、下载工具、背景和图鉴均已完成初始化。"
        : "部分阶段失败；已完成的阶段会保留，下次执行将从实际状态继续检查和修复。",
      userId: this.e.user_id,
      items: buildInitializationSummaryItems(bootstrap.results, runtime, {
        restartRecommended: bootstrap.restartRecommended,
      }),
    }, { saveId: `lotus-full-initialization-${this.e.user_id || "master"}` })
    await replyImage(this, image, ok ? "[荷花插件]完整初始化完成。" : "[荷花插件]完整初始化存在失败项，请查看阶段反馈。")
  }
}

async function runtimeStep(name, task) {
  try {
    return { name, ok: true, value: await task() }
  } catch (error) {
    globalThis.logger?.warn?.(`[Lotus-Plugin] full initialization ${name} failed: ${error.message}`)
    return { name, ok: false, value: error.message }
  }
}
