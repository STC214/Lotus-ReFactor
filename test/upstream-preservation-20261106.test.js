import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { migrateGlobalConfig } from "../core/config/global.js"
import { createDefaultGlobalConfig } from "../core/config/defaults.js"
import { ToolInstallerService } from "../services/tools/installer.js"
import { prepareStartupEnvironment } from "../services/tools/runtime.js"
import { LOTUS_CONFIG_DISABLED_PLUGIN_NAMES } from "../core/intercept/priority.js"
import { ProfileSigninService } from "../services/checkin/profileSignin.js"

test("upstream migration preserves fork configuration and account metadata", () => {
  const input = {
    render: { background_pool_size: 30, super_resolution_preset: "off", background: ["local.jpg"] },
    python: { system_python: "python3", venv_path: "data/custom-venv" },
    scheduler: { mode: "random", plan_date_cutoff_time: "23:00", failure_retry_minutes: ["15", "60"] },
    captcha: { test_nine: { auto_start: false, download_models: false, venv_path: "data/retained-venv" } },
    tools: { auto_install: false, bbdown: { command: "my-BBDown" }, aria2: { enable: false } },
    bilibili: { cookie: "fixture-cookie", download: { use_aria2: false, extra_args: ["--fixture"], multi_page_policy: "first" } },
    logging: { retention_days: 31 },
  }
  const original = structuredClone(input)
  const output = migrateGlobalConfig(input)
  assert.deepEqual(input, original)
  for (const [key, value] of Object.entries(input.render)) assert.deepEqual(output.render[key], value)
  assert.equal(output.python.venv_path, input.python.venv_path)
  assert.equal(output.scheduler.mode, "random")
  assert.equal(output.scheduler.plan_date_cutoff_time, "23:00")
  assert.deepEqual(output.scheduler.failure_retry_minutes, ["15", "60"])
  assert.equal(output.captcha.test_nine.auto_start, false)
  assert.equal(output.captcha.test_nine.download_models, false)
  assert.equal(output.captcha.test_nine.venv_path, "data/retained-venv")
  assert.equal(output.tools.auto_install, false)
  assert.equal(output.tools.bbdown.command, "my-BBDown")
  assert.equal(output.tools.aria2.enable, false)
  assert.equal(output.bilibili.cookie, "fixture-cookie")
  assert.deepEqual(output.bilibili.download.extra_args, ["--fixture"])
  assert.equal(output.bilibili.download.use_aria2, false)
  assert.equal(output.logging.retention_days, 31)
})

test("new overlapping commands do not expand the fork's disabled plugin list", () => {
  for (const name of ["小飞插件_代发言", "小飞插件_点歌", "[土块插件]点歌", "兑换码", "[ZZZ-Plugin]Code"]) {
    assert.equal(LOTUS_CONFIG_DISABLED_PLUGIN_NAMES.includes(name), false)
  }
})

test("legacy tools dispatch separately while disabled tools perform no work", async () => {
  const service = new ToolInstallerService({ config: { ffmpeg: { enable: false } } })
  const called = []
  service.installLegacyTool = async name => { called.push(name); return { ok: true, name } }
  await service.ensureTool("bbdown")
  await service.ensureTool("aria2")
  assert.deepEqual(called, ["bbdown", "aria2"])
  assert.equal((await service.ensureTool("ffmpeg")).skipped, true)
})

test("healthy system ffmpeg and ffprobe are reused without release requests", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-system-tools-"))
  const commands = []
  const spawn = (command, args) => {
    commands.push([command, ...args])
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough()
    queueMicrotask(() => child.emit("close", 0))
    return child
  }
  try {
    await fs.writeFile(path.join(dir, "ffmpeg"), "fixture", { mode: 0o755 })
    await fs.writeFile(path.join(dir, "ffprobe"), "fixture", { mode: 0o755 })
    const service = new ToolInstallerService({ platform: "linux", env: { PATH: dir }, spawn,
      config: { dir: path.join(dir, "managed"), bin_dir: path.join(dir, "bin") },
      fetch: async () => { throw new Error("network must not be used for external tools") } })
    assert.equal((await service.ensureTool("ffmpeg")).status, "system")
    assert.equal(commands.length, 2)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test("automatic maintenance respects captcha opt-outs and retains Python environments", async () => {
  for (const controls of [{ enable: false }, { auto_start: false }]) {
    const config = createDefaultGlobalConfig()
    Object.assign(config.captcha.test_nine, controls)
    let modelCalls = 0, serverCalls = 0, cleanupCalls = 0
    const result = await prepareStartupEnvironment(config, { automatic: true,
      modelEnv: { ensureEnv: async () => { modelCalls++; return { ok: true } } },
      captchaServer: { start: async () => { serverCalls++; return { ok: true } } },
      installer: { ensureAll: async () => ({ ok: true, items: [] }) },
      service: { localUrl() { throw new Error("remote deployment") } },
      cleanup: async () => { cleanupCalls++; return { removed: true } },
    })
    assert.equal(modelCalls, 0); assert.equal(serverCalls, 0); assert.equal(cleanupCalls, 0)
    assert.equal(result.cleanup.removed, false)
  }
})

test("all plugin app entry points resolve their dependencies without starting services", async () => {
  globalThis.plugin ||= class { constructor(options) { Object.assign(this, options) } }
  for (const file of (await fs.readdir(new URL("../apps/", import.meta.url))).filter(name => name.endsWith(".js"))) {
    await assert.doesNotReject(import(new URL("../apps/" + file, import.meta.url)), file)
  }
})

test("new native inference and SQLite dependencies load", async () => {
  const ort = await import("onnxruntime-node")
  assert.equal(typeof ort.InferenceSession.create, "function")
  const { default: init } = await import("sql.js")
  const SQL = await init(), db = new SQL.Database()
  try { assert.equal(db.exec("SELECT 42")[0].values[0][0], 42) } finally { db.close() }
})

test("native sign-in keeps the fork timeout and blocks requests after cancellation", async () => {
  let options
  const service = new ProfileSigninService({ render: false, appendAudit: async () => {},
    runner: { runProfile: async (_profile, value) => {
      options = value
      return new Promise((_, reject) => value.signal.addEventListener("abort", () => reject(value.signal.reason), { once: true }))
    } },
  })
  const result = await service.run({ qq: "123", profileId: 1, profile: { account: { cookie: "fixture" } },
    refresh: false, timeoutMs: 10, beforeRequest: async () => {} })
  assert.equal(result.stage, "timeout")
  assert.equal(result.error.code, "LOTUS_RUNNER_TIMEOUT")
  assert.equal(options.signal.aborted, true)
  await assert.rejects(options.beforeRequest({}), error => error.code === "LOTUS_RUNNER_TIMEOUT")
  assert.equal(globalThis.__LOTUS_SIGNIN_COORDINATOR__.active, 0)
})
