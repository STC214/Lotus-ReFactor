import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { autoStartTestNineServer } from "../services/testNine/server.js"

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const indexUrl = new URL("../index.js", import.meta.url)
const source = fs.readFileSync(indexUrl, "utf8")
  .replace(/^import .*$/gm, "")
  .replaceAll("import.meta.url", JSON.stringify(indexUrl.href))
  .replace(/^export \{ apps \}\s*$/m, "")

function boot({ config = { captcha: { test_nine: { enable: true, auto_start: true } } }, start, configError = false, sync } = {}) {
  const calls = [], warnings = [], marks = []
  const logger = { info() {}, debug() {}, error() {}, mark: value => marks.push(value), warn: value => warnings.push(value) }
  const names = ["fs", "logger", "ensureGeneratedProfileDevices", "startGeneratedDeviceFpRefresh", "installLotusRuntimeInterception", "ensureGlobalConfig", "autoStartTestNineServer", "ensureBackgroundPool", "applyWorkspacePolicy", "checkTrackedSubmoduleRemoteUpdates", "notifySubmoduleSyncFailure", "syncTrackedSubmodules", "startLoginCredentialRepair"]
  const values = [
    { readdir: async () => [] }, logger, async () => ({}), () => {}, async () => {},
    async () => { if (configError) throw new Error("controlled config failure"); return { config } },
    async options => { calls.push(options); return start ? start(options) : { ok: true, running: true } },
    async () => [], async () => ({ changed: false }), async () => ({}), () => {}, sync || (async () => ({ ok: true })), () => {}
  ]
  return { done: new AsyncFunction(...names, source)(...values), calls, warnings, marks, config }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test("plugin initialization calls native auto-start once with the loaded configuration", async () => {
  const state = boot()
  await state.done
  await tick()
  assert.equal(state.calls.length, 1)
  assert.equal(state.calls[0].globalConfig, state.config)
  assert.ok(state.marks.some(value => value.includes("本地验证码服务已自动启动")))
})

test("a pending native startup never blocks plugin application loading", async () => {
  const state = boot({ start: () => new Promise(() => {}) })
  await state.done
  assert.equal(state.calls.length, 1)
})

test("native startup rejection is reported without rejecting plugin initialization", async () => {
  const state = boot({ start: async () => { throw new Error("controlled startup failure") } })
  await state.done
  await tick()
  assert.ok(state.warnings.some(value => value.includes("controlled startup failure")))
})

test("an unsuccessful environment result is visible rather than silently ignored", async () => {
  const state = boot({ start: async () => ({ ok: false, reason: "controlled missing models" }) })
  await state.done
  await tick()
  assert.ok(state.warnings.some(value => value.includes("controlled missing models")))
})

test("startup integration retains both existing opt-out flags before opening any listener", async () => {
  for (const disabled of [{ enable: false, auto_start: true }, { enable: true, auto_start: false }]) {
    const state = boot({ config: { captcha: { test_nine: { ...disabled, endpoint: "https://external.example.test/pass_uni" } } }, start: autoStartTestNineServer })
    await state.done
    await tick()
    assert.equal(state.calls.length, 1)
    assert.equal(state.warnings.length, 0)
    assert.equal(state.marks.some(value => value.includes("本地验证码服务已自动启动")), false)
  }
})

test("failed configuration loading never starts a service using invented defaults", async () => {
  const state = boot({ configError: true })
  await state.done
  assert.equal(state.calls.length, 0)
})

test("native startup begins before unrelated submodule synchronization completes", async () => {
  let finishSync
  const state = boot({ sync: () => new Promise(resolve => { finishSync = resolve }) })
  await tick()
  assert.equal(state.calls.length, 1)
  finishSync({ ok: true })
  await state.done
})
