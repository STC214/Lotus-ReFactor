import { initializeEnvironment } from "./environment.js"
import { TestNineEnvService } from "../testNine/nativeEnv.js"
import { TestNineServerService } from "../testNine/server.js"
import { TuneWeaveService } from "../tuneweave/service.js"

function localCaptchaEndpoint(value = "http://127.0.0.1:9645/pass_uni") {
  try {
    const url = new URL(value)
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password
  } catch { return false }
}

// Shared by the existing delayed TuneWeave lifecycle. This function neither
// schedules another timer nor touches an externally managed captcha service.
export async function prepareStartupEnvironment(config, options = {}) {
  const { signal, notify = async () => {} } = options
  const service = options.service || new TuneWeaveService({ config: config.tuneweave })
  const progress = async message => { signal?.throwIfAborted(); try { await notify(message) } catch {} }
  signal?.throwIfAborted()
  const local = { ...config.captcha?.test_nine }
  const isLocal = localCaptchaEndpoint(local.endpoint) && local.enable !== false &&
    (!options.automatic || local.auto_start !== false)
  // Keep the fork's enable/auto-start controls; remote endpoints stay external.
  const effective = { ...config,
    tools: { ...config.tools },
    captcha: { ...config.captcha, test_nine: { ...local, enable: isLocal } },
  }
  let preparedModels, captchaFailure
  const startPreparedCaptcha = async () => {
    if (!preparedModels?.ok) return
    try {
      const server = options.captchaServer || new TestNineServerService({ config: local, envService: { ensureEnv: async () => preparedModels } })
      if (preparedModels.models?.changed && server.status?.().running) server.stop()
      const ready = await server.start()
      signal?.throwIfAborted()
      if (!ready.ok) throw new Error("local server not ready")
    } catch (error) {
      signal?.throwIfAborted()
      captchaFailure = { name: "本地验证码服务", ok: false, reason: error.code === "EADDRINUSE"
        ? "本地验证码端口被占用，未停止占用进程；请检查旧服务，原环境已保留"
        : "本地监听未就绪；已保留原环境" }
    }
  }
  const modelEnv = options.modelEnv || new TestNineEnvService({ config: local, onProgress: progress })
  const guardedModelEnv = { ensureEnv: async () => {
    signal?.throwIfAborted()
    preparedModels = await modelEnv.ensureEnv({ onProgress: progress, checkUpdates: true, allowOffline: true, downloadModels: local.download_models !== false })
    signal?.throwIfAborted()
    await startPreparedCaptcha()
    return preparedModels
  } }
  const tuneweave = { initialize: async ({ onProgress }) => {
    signal?.throwIfAborted()
    try { service.localUrl() } catch { return { ok: true, message: "外部服务由部署者维护" } }
    const result = await service.initialize({ onProgress })
    signal?.throwIfAborted()
    return result
  } }
  const result = await initializeEnvironment(effective, { modelEnv: guardedModelEnv, installer: options.installer, tuneweave, onProgress: progress })
  signal?.throwIfAborted()
  if (captchaFailure) result.items.push(captchaFailure)
  result.ok = result.items.every(item => item.ok)
  // This fork still exposes the legacy Python initialization/runner. Its venv
  // remains user data even when native captcha preparation has succeeded.
  result.cleanup = { ok: true, removed: false, reason: "fork_legacy_environment_retained" }
  return result
}
