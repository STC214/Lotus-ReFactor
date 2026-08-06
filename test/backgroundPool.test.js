import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { createDefaultGlobalConfig } from "../core/config/defaults.js"
import { validateGlobalConfig } from "../core/config/schema.js"
import { GUOBA_SCHEMAS } from "../guoba.support.js"
import {
  createRenderBackgroundProvider,
  ensureBackgroundPool,
  getRenderBackgrounds,
  refreshBackgroundPool,
  resolveSuperResolutionScale,
} from "../core/render/background.js"

function config(overrides = {}) {
  return {
    render: {
      background: ["https://source.slow/api", "https://source.fast/api"],
      background_pool_enable: true,
      background_pool_size: 10,
      background_timeout_ms: 1000,
      background_download_retries: 2,
      background_max_bytes: 1024 * 1024,
      ...overrides,
    },
  }
}

function image(seed) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24, seed),
  ])
}

function createFetch(seedOffset = 0) {
  const counters = { fast: 0, slow: 0 }
  const fetchMock = async url => {
    const text = String(url)
    if (text.includes("source.")) {
      const kind = text.includes("fast") ? "fast" : "slow"
      counters[kind] += 1
      await new Promise(resolve => setTimeout(resolve, kind === "fast" ? 2 : 35))
      return new Response(JSON.stringify({ url: `https://img.${kind}/${counters[kind]}.png` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    const match = text.match(/img\.(fast|slow)\/(\d+)/)
    if (!match) return new Response("missing", { status: 404 })
    await new Promise(resolve => setTimeout(resolve, match[1] === "fast" ? 1 : 20))
    return new Response(image(seedOffset + Number(match[2]) + (match[1] === "fast" ? 10 : 100)), {
      status: 200,
      headers: { "content-type": "image/png" },
    })
  }
  fetchMock.counters = counters
  return fetchMock
}

test("refresh benchmarks sources, keeps ten local images and removes previous generation", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-background-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const oldDir = path.join(root, "generations", "old")
  await fs.mkdir(oldDir, { recursive: true })
  await fs.writeFile(path.join(oldDir, "old.png"), image(1))
  await fs.writeFile(path.join(root, "legacy.jpg"), image(2))
  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify({ generation: "old", files: [{ name: "old.png" }] }))

  const result = await refreshBackgroundPool(config(), {
    poolRoot: root,
    fetch: createFetch(),
    now: new Date("2026-08-03T04:10:00.000Z"),
    random: () => 0,
    cleanupDelayMs: 0,
  })

  assert.equal(result.ok, true)
  assert.equal(result.files.length, 10)
  assert.equal(result.manifest.selectedSource, "https://source.fast/api")
  assert.equal((await fs.readdir(path.join(root, "generations"))).length, 1)
  await assert.rejects(fs.access(path.join(root, "legacy.jpg")))
  for (const file of result.files) assert.match(file, /^file:/)

  const localOnly = await getRenderBackgrounds(10, config(), {
    poolRoot: root,
    fetch: async () => { throw new Error("render path reached network") },
    random: () => 0,
  })
  assert.equal(localOnly.length, 10)
})

test("provider reloads the manifest when daily rotation changes generation and filenames", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-background-rotate-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const settings = config()
  const first = await refreshBackgroundPool(settings, {
    poolRoot: root,
    fetch: createFetch(0),
    now: new Date("2026-08-03T04:10:00.000Z"),
    random: () => 0,
    cleanupDelayMs: 0,
  })
  const provider = await createRenderBackgroundProvider(settings, { poolRoot: root, random: () => 0 })
  const oldGeneration = first.manifest.generation

  const second = await refreshBackgroundPool(settings, {
    poolRoot: root,
    fetch: createFetch(40),
    now: new Date("2026-08-04T04:10:00.000Z"),
    random: () => 0,
    cleanupDelayMs: 0,
  })
  assert.notEqual(second.manifest.generation, oldGeneration)
  assert.notDeepEqual(second.manifest.files.map(item => item.name), first.manifest.files.map(item => item.name))

  const rotated = await provider()
  assert.equal(rotated.includes(second.manifest.generation), true)
  await fs.access(fileURLToPath(rotated))
  await assert.rejects(fs.access(path.join(root, "generations", oldGeneration)))
})

test("missing manifest file triggers an automatic full-pool repair", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-background-repair-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const settings = config()
  const first = await refreshBackgroundPool(settings, {
    poolRoot: root,
    fetch: createFetch(0),
    random: () => 0,
    cleanupDelayMs: 0,
  })
  await fs.rm(fileURLToPath(first.files[0]))

  const repaired = await ensureBackgroundPool(settings, {
    poolRoot: root,
    fetch: createFetch(80),
    random: () => 0,
    cleanupDelayMs: 0,
  })
  assert.equal(repaired.length, 10)
  assert.equal(repaired.every(file => !file.includes(first.manifest.generation)), true)
  for (const file of repaired) await fs.access(fileURLToPath(file))
})

test("concurrent startup and scheduled refresh share one update operation", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-background-lock-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const fetchMock = createFetch(120)
  const options = { poolRoot: root, fetch: fetchMock, random: () => 0, cleanupDelayMs: 0 }
  const [left, right] = await Promise.all([
    refreshBackgroundPool(config(), options),
    refreshBackgroundPool(config(), options),
  ])
  assert.strictEqual(left, right)
  assert.equal(left.files.length, 10)
  assert.equal((await fs.readdir(path.join(root, "generations"))).length, 1)
})

test("delayed cleanup always protects the newest manifest generation", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-background-grace-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const settings = config()
  await refreshBackgroundPool(settings, {
    poolRoot: root,
    fetch: createFetch(0),
    cleanupDelayMs: 40,
    random: () => 0,
  })
  const newest = await refreshBackgroundPool(settings, {
    poolRoot: root,
    fetch: createFetch(50),
    cleanupDelayMs: 40,
    random: () => 0,
  })
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.deepEqual(await fs.readdir(path.join(root, "generations")), [newest.manifest.generation])
  for (const file of newest.files) await fs.access(fileURLToPath(file))
})

test("local-only image directories expand to usable files without network", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-background-local-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const gallery = path.join(root, "gallery")
  await fs.mkdir(gallery)
  await fs.writeFile(path.join(gallery, "a.png"), image(1))
  await fs.writeFile(path.join(gallery, "b.jpg"), image(2))
  await fs.writeFile(path.join(gallery, "ignore.txt"), "not an image")
  const files = await ensureBackgroundPool(config({ background: [gallery] }), {
    poolRoot: path.join(root, "pool"),
    fetch: async () => { throw new Error("network should not run") },
    random: () => 0,
  })
  assert.equal(files.length, 2)
  for (const file of files) await fs.access(fileURLToPath(file))
})

test("failed refresh preserves the active local generation", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-background-fail-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const oldDir = path.join(root, "generations", "old")
  await fs.mkdir(oldDir, { recursive: true })
  await fs.writeFile(path.join(oldDir, "old.png"), image(3))
  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify({ generation: "old", files: [{ name: "old.png" }] }))

  await assert.rejects(refreshBackgroundPool(config(), {
    poolRoot: root,
    fetch: async () => new Response("bad", { status: 503 }),
  }), /测速全部失败/)
  await fs.access(path.join(oldDir, "old.png"))
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"))
  assert.equal(manifest.generation, "old")
})

test("super-resolution presets map to bounded render scales", () => {
  assert.equal(resolveSuperResolutionScale("off"), 1)
  assert.equal(resolveSuperResolutionScale("medium"), 2)
  assert.equal(resolveSuperResolutionScale("ultra"), 4)
  assert.equal(resolveSuperResolutionScale("unknown"), 1)
})

test("default config and Guoba expose background schedule and resolution preset", () => {
  assert.deepEqual(validateGlobalConfig(createDefaultGlobalConfig()), [])
  const fields = new Set(GUOBA_SCHEMAS.map(item => item.field).filter(Boolean))
  assert.equal(GUOBA_SCHEMAS.some(item => item.scheduleField === "render.background_refresh_cron"), true)
  assert.equal(fields.has("render.super_resolution_preset"), true)
  assert.equal(fields.has("render.background_retry_enable"), true)
  assert.equal(fields.has("render.background_retry_delays_minutes"), true)
})
