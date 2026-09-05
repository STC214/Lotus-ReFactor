import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import YAML from "yaml"
import { createDefaultGlobalConfig } from "../core/config/defaults.js"
import { validateGlobalConfig } from "../core/config/schema.js"
import {
  LOTUS_CAPTCHA_HANDLER_PRIORITY,
  LOTUS_CONFIG_DISABLED_PLUGIN_NAMES,
  LOTUS_INTERCEPT_PRIORITY,
} from "../core/intercept/priority.js"
import {
  cleanupLegacyYunzaiConflictDisableConfig,
  enforceLotusInterception,
  installLotusCaptchaHandlerOverride,
  patchPluginsLoader,
} from "../services/intercept/runtime.js"
import { supportGuoba } from "../guoba.support.js"

test("legacy conflict takeover is disabled by default and hidden from Guoba", () => {
  const config = createDefaultGlobalConfig()
  assert.equal(config.compatibility.conflict_takeover, false)
  assert.equal(config.compatibility.captcha_priority_takeover, true)
  assert.deepEqual(validateGlobalConfig(config), [])
  const schema = supportGuoba().configInfo.schemas.find(item => item.field === "compatibility.conflict_takeover")
  assert.equal(schema, undefined)
  const captchaSchema = supportGuoba().configInfo.schemas.find(item => item.field === "compatibility.captcha_priority_takeover")
  assert.equal(captchaSchema?.component, "Switch")
})

test("invalid conflict takeover configuration is rejected", () => {
  const config = createDefaultGlobalConfig()
  config.compatibility.conflict_takeover = "yes"
  assert.match(validateGlobalConfig(config).join("\n"), /conflict_takeover must be boolean/)
})

test("coexistence mode prioritizes Lotus captcha and preserves fallback handlers", async () => {
  const added = []
  const removed = []
  const handler = {
    add: cfg => added.push(cfg),
    del: (ns, key) => removed.push({ ns, key }),
  }
  const self = {}
  const fn = async () => {}
  const result = await installLotusCaptchaHandlerOverride(handler, {
    config: createDefaultGlobalConfig(),
    registration: { self, fn },
  })
  assert.deepEqual(result, {
    ok: true,
    conflictTakeover: false,
    captchaPriorityTakeover: true,
    fallbackHandlersPreserved: true,
  })
  assert.equal(removed.length, 0)
  assert.equal(added.length, 1)
  assert.equal(added[0].ns, "Lotus-Plugin")
  assert.equal(added[0].key, "mys.req.err")
  assert.equal(added[0].priority, LOTUS_CAPTCHA_HANDLER_PRIORITY)
  assert.equal(added[0].self, self)
  assert.equal(added[0].fn, fn)
})

test("ordinary Lotus commands always sort after overlapping commands", () => {
  assert.equal(LOTUS_INTERCEPT_PRIORITY, Number.POSITIVE_INFINITY)
  const lotus = { key: "Lotus-Plugin.profile", priority: Number.NEGATIVE_INFINITY }
  const samePriorityOther = { key: "miao-plugin.profile", priority: Number.POSITIVE_INFINITY }
  const normalOther = { key: "Yunzai.profile", priority: 5000 }
  const loader = { priority: [lotus, samePriorityOther, normalOther] }

  assert.deepEqual(enforceLotusInterception(loader), { ok: true, pruned: 0 })
  assert.equal(lotus.priority, Number.NEGATIVE_INFINITY)
  assert.deepEqual(loader.priority, [normalOther, samePriorityOther, lotus])
})

test("every Lotus message app directly declares fallback priority", async () => {
  const appsDir = path.resolve("apps")
  const files = (await fs.readdir(appsDir)).filter(file => file.endsWith(".js"))
  const violations = []
  let checked = 0

  for (const file of files) {
    const source = await fs.readFile(path.join(appsDir, file), "utf8")
    if (!/event:\s*["']message["']/.test(source)) continue
    if (!/name:\s*["']\[Lotus-Plugin\]/.test(source)) continue
    checked += 1
    const declared = source.match(/priority:\s*([^,\n]+)/)?.[1]?.trim()
    if (declared !== "LOTUS_INTERCEPT_PRIORITY") violations.push(`${file}: ${declared || "missing"}`)
  }

  assert.ok(checked > 0)
  assert.deepEqual(violations, [])
})

test("missing plugin loader is retryable instead of being marked successful", async () => {
  assert.deepEqual(await patchPluginsLoader(null), {
    ok: false,
    retryable: true,
    reason: "loader priority unavailable",
  })
})

test("captcha priority routing can be disabled independently", async () => {
  const config = createDefaultGlobalConfig()
  config.compatibility.captcha_priority_takeover = false
  const result = await installLotusCaptchaHandlerOverride(null, { config })
  assert.deepEqual(result, {
    ok: true,
    skipped: true,
    reason: "captcha_priority_takeover_disabled",
  })
})

test("legacy full disable signature is removed without touching user entries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-coexist-"))
  const file = path.join(dir, "group.yaml")
  const userEntry = "keep-user-disabled-plugin"
  await fs.writeFile(file, YAML.stringify({
    default: { disable: [userEntry, ...LOTUS_CONFIG_DISABLED_PLUGIN_NAMES] },
  }))

  const result = await cleanupLegacyYunzaiConflictDisableConfig({ file })
  const saved = YAML.parse(await fs.readFile(file, "utf8"))
  assert.equal(result.changed, true)
  assert.equal(result.removed.length, LOTUS_CONFIG_DISABLED_PLUGIN_NAMES.length)
  assert.deepEqual(saved.default.disable, [userEntry])
})

test("partial disable lists are preserved because ownership is ambiguous", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-coexist-partial-"))
  const file = path.join(dir, "group.yaml")
  const original = { default: { disable: [LOTUS_CONFIG_DISABLED_PLUGIN_NAMES[0], "user-entry"] } }
  await fs.writeFile(file, YAML.stringify(original))

  const result = await cleanupLegacyYunzaiConflictDisableConfig({ file })
  const saved = YAML.parse(await fs.readFile(file, "utf8"))
  assert.equal(result.skipped, true)
  assert.equal(result.reason, "legacy_signature_not_found")
  assert.deepEqual(saved, original)
})
