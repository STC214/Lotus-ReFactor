import test from "node:test"
import assert from "node:assert/strict"
import { TestNineEnvService, normalizeTestNineConfig } from "../services/testNine/nativeEnv.js"
import { autoStartTestNineServer } from "../services/testNine/server.js"

test("native config retains both legacy opt-out controls", () => {
  const config = normalizeTestNineConfig({ auto_start: false, download_models: false })
  assert.equal(config.auto_start, false)
  assert.equal(config.download_models, false)
  assert.equal(normalizeTestNineConfig().auto_start, true)
  assert.equal(normalizeTestNineConfig().download_models, true)
})

test("direct native environment checks never download when config disables models", async () => {
  let checked = 0, downloaded = 0
  const env = new TestNineEnvService({ config: { download_models: false } })
  env.modelStatus = async () => { checked++; return { ok: true, items: [] } }
  env.ensureModels = async () => { downloaded++; return { ok: true, items: [] } }
  assert.equal((await env.ensureEnv()).ok, true)
  assert.equal(checked, 1)
  assert.equal(downloaded, 0)
  await env.ensureEnv({ downloadModels: true })
  assert.equal(downloaded, 1)
})

test("exported auto-start helper honors disabled auto-start before any listener or download", async () => {
  const result = await autoStartTestNineServer({ globalConfig: { captcha: { test_nine: {
    enable: true, auto_start: false, endpoint: "https://external.example.test/pass_uni",
  } } } })
  assert.equal(result.skipped, true)
})
