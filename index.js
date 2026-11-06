import fs from "node:fs/promises"
import { ensureGeneratedProfileDevices } from "./core/devices/generated-profile.js"
import { startGeneratedDeviceFpRefresh } from "./core/devices/runtime.js"
import { installLotusRuntimeInterception } from "./services/intercept/runtime.js"
import { ensureGlobalConfig } from "./core/config/global.js"
import { autoStartTestNineServer } from "./services/testNine/server.js"
import { ensureBackgroundPool } from "./core/render/background.js"
import { applyWorkspacePolicy } from "./scripts/initialize-lotus.mjs"
import { checkTrackedSubmoduleRemoteUpdates, notifySubmoduleSyncFailure, syncTrackedSubmodules } from "./services/pluginUpdate/service.js"
import { startLoginCredentialRepair } from "./core/login/runtime.js"

const pluginName = "Lotus-Plugin"
const appsDir = new URL("./apps/", import.meta.url)

logger?.info?.("---- Lotus-Plugin refactor loading ----")

await applyWorkspacePolicy().then(result => {
  if (result.changed) logger?.mark?.(`[${pluginName}] restored pnpm workspace build policy`)
}).catch(error => {
  logger?.warn?.(`[${pluginName}] workspace build policy restore skipped: ${error.message}`)
})

let startupConfig = {}
await ensureGlobalConfig().then(result => {
  startupConfig = result.config || {}
  if (result.created) logger?.mark?.(`[${pluginName}] created default config: ${result.file}`)
}).catch(error => {
  logger?.warn?.(`[${pluginName}] global config init skipped: ${error.message}`)
})

void checkTrackedSubmoduleRemoteUpdates({ config: startupConfig }).then(result => {
  if (result.updates?.length) logger?.warn?.(`[${pluginName}] ${result.message}`)
}).catch(error => {
  logger?.debug?.(`[${pluginName}] submodule remote check skipped: ${error.message}`)
})

await ensureGeneratedProfileDevices().then(result => {
  if (result.generated || result.failed || result.invalid) logger?.info?.(`[${pluginName}] 设备初始化：${result.generated} 个虚拟设备已保存，${result.failed + result.invalid} 个档案暂未处理`)
}).catch(() => {
  logger?.warn?.(`[${pluginName}] 虚拟设备初始化暂不可用，已保留原档案`)
})

await installLotusRuntimeInterception().catch(error => {
  logger?.debug?.(`[${pluginName}] runtime interception skipped: ${error.message}`)
})

await syncTrackedSubmodules().then(result => {
  if (result.action === "submodules_updated") {
    logger?.mark?.("[" + pluginName + "] " + result.message)
  } else if (!result.ok) {
    logger?.warn?.("[" + pluginName + "] submodule sync skipped: " + result.message)
    void notifySubmoduleSyncFailure(result)
  }
}).catch(error => {
  logger?.warn?.("[" + pluginName + "] submodule sync skipped: " + error.message)
  void notifySubmoduleSyncFailure({ ok: false, message: "子模块启动同步异常。" })
})

startLoginCredentialRepair()
startGeneratedDeviceFpRefresh()

ensureBackgroundPool(null, { cleanupExisting: true }).then(files => {
  logger?.mark?.(`[${pluginName}] 本地背景池就绪：${files.length} 张`)
}).catch(error => {
  logger?.warn?.(`[${pluginName}] 首次背景本地化失败，将在下次启动或定时任务重试：${error.message}`)
})

const files = await fs.readdir(appsDir).catch(err => {
  logger?.error?.(`[${pluginName}] failed to read apps directory`)
  logger?.error?.(err)
  return []
})

const modules = await Promise.allSettled(
  files.filter(file => file.endsWith(".js")).map(file => import(new URL(file, appsDir))),
)

const apps = {}
for (const [index, result] of modules.entries()) {
  const file = files.filter(name => name.endsWith(".js"))[index]
  const name = file.replace(/\.js$/, "")

  if (result.status !== "fulfilled") {
    logger?.error?.(`[${pluginName}] failed to load app: ${name}`)
    logger?.error?.(result.reason)
    continue
  }

  const exported = result.value[Object.keys(result.value)[0]]
  if (exported) apps[name] = silencePluginLogs(exported)
}

logger?.info?.(`Lotus-Plugin refactor loaded: ${Object.keys(apps).length} app(s)`)

export { apps }

function silencePluginLogs(AppClass) {
  return class LotusSilentPluginLogs extends AppClass {
    constructor(...args) {
      super(...args)
      silenceEntries(this.rule)
      silenceEntries(this.task)
    }
  }
}

function silenceEntries(entries) {
  if (!entries) return
  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    if (entry && typeof entry === "object") entry.log = false
  }
}
