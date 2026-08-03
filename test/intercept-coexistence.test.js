import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import YAML from "yaml"
import { createDefaultGlobalConfig } from "../core/config/defaults.js"
import { validateGlobalConfig } from "../core/config/schema.js"
import { LOTUS_CONFIG_DISABLED_PLUGIN_NAMES } from "../core/intercept/priority.js"
import {
  cleanupLegacyYunzaiConflictDisableConfig,
  installLotusCaptchaHandlerOverride,
} from "../services/intercept/runtime.js"
import { supportGuoba } from "../guoba.support.js"

test("conflict takeover is disabled by default and exposed in Guoba", () => {
  const config = createDefaultGlobalConfig()
  assert.equal(config.compatibility.conflict_takeover, false)
  assert.deepEqual(validateGlobalConfig(config), [])
  const schema = supportGuoba().configInfo.schemas.find(item => item.field === "compatibility.conflict_takeover")
  assert.equal(schema?.component, "Switch")
})

test("invalid conflict takeover configuration is rejected", () => {
  const config = createDefaultGlobalConfig()
  config.compatibility.conflict_takeover = "yes"
  assert.match(validateGlobalConfig(config).join("\n"), /conflict_takeover must be boolean/)
})

test("coexistence mode skips legacy captcha handler takeover", async () => {
  const result = await installLotusCaptchaHandlerOverride(null, {
    config: createDefaultGlobalConfig(),
  })
  assert.deepEqual(result, {
    ok: true,
    skipped: true,
    reason: "conflict_takeover_disabled",
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
