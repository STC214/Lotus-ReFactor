import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { Canvas } from "skia-canvas"
import sharp from "sharp"
import { encodeGpuCanvas } from "../core/render/gpu-buffer.js"
import { renderWithSkia, usesForkBackgroundLayout } from "../core/render/skia.js"
import { BilibiliService } from "../services/bilibili/service.js"
import { DouyinService } from "../services/douyin/service.js"
import { collectMasterIds } from "../services/pluginUpdate/service.js"

test("submodule notices omit missing or malformed master IDs and deduplicate real IDs", () => {
  const previous = globalThis.Bot
  try {
    globalThis.Bot = { config: {} }
    assert.deepEqual(collectMasterIds(), [])
    globalThis.Bot = { config: { masterQQ: [123456, null, "", "undefined"] } }
    assert.deepEqual(collectMasterIds({ masters: [" 123456 ", "234567", undefined, "null", "abc"] }), ["123456", "234567"])
  } finally {
    globalThis.Bot = previous
  }
})

test("CPU card encoding keeps exact dimensions without requiring a physical GPU", async () => {
  const canvas = new Canvas(100, 60)
  canvas.gpu = false
  const ctx = canvas.getContext("2d")
  ctx.fillStyle = "#ff0000"
  ctx.fillRect(0, 0, 100, 60)
  const result = await encodeGpuCanvas(canvas, { imgType: "png" })
  const meta = await sharp(result.buffer).metadata()
  assert.equal(meta.width, 100)
  assert.equal(meta.height, 60)
  assert.equal(result.format, "png")
})

test("new source cards and the fork's graphical help both produce real images", async () => {
  const status = await renderWithSkia("status", {
    title: "更新验证", items: [{ label: "状态", value: "正常" }],
  }, { renderScale: 1, imgType: "png" })
  const help = await renderWithSkia("help", {
    title: "指令帮助", sections: [{ title: "攻略", body: "#胡桃攻略" }],
  }, { renderScale: 1, imgType: "png" })
  for (const image of [status, help]) {
    const meta = await sharp(image).metadata()
    assert.ok(meta.width >= 720)
    assert.ok(meta.height >= 240)
  }
})

test("configured rotating backgrounds retain the fork layout", async () => {
  assert.equal(usesForkBackgroundLayout("status", { backgroundProvider: async () => "" }), true)
  assert.equal(usesForkBackgroundLayout("status", {}), false)
  assert.equal(usesForkBackgroundLayout("douyin-info", { bg: "custom.png" }), false)
  const image = await renderWithSkia("status", { title: "背景轮换", backgroundProvider: async () => "" }, { renderScale: 1, imgType: "png" })
  assert.equal((await sharp(image).metadata()).width, 760)
})

test("media task defaults stay inside the existing LLBot downloads mount", () => {
  const bili = new BilibiliService()
  const douyin = new DouyinService()
  assert.equal(path.dirname(bili.tasksDir), bili.mediaTasksRoot)
  assert.equal(path.dirname(douyin.tasksDir), bili.mediaTasksRoot)
  assert.equal(path.dirname(bili.mediaTasksRoot), bili.outputDir)
})

test("legacy scheduled cleanup never removes active Bilibili or Douyin tasks", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-task-protection-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const outputDir = path.join(root, "downloads")
  const service = new BilibiliService({ outputDir, tmpDir: path.join(root, "tmp"), cacheFile: path.join(root, "cache.yaml") })
  const files = ["bilibili", "douyin"].map(kind => path.join(outputDir, "tasks", kind, "job", "video.mp4"))
  for (const file of files) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, Buffer.alloc(2 * 1024 * 1024))
    const old = new Date(Date.now() - 7 * 86400000)
    await fs.utimes(file, old, old)
  }
  await service.writeCache({ stale: { files, expires_at: "2000-01-01" } })
  await service.cleanupDownloads({ cleanup: { retention_days: 1, tmp_retention_hours: 0, max_total_size_mb: 1 } })
  for (const file of files) assert.equal((await fs.stat(file)).size, 2 * 1024 * 1024)
})

test("Bilibili app preserves its bound cleanup task after upstream task recovery merge", async () => {
  globalThis.plugin = class { constructor(options) { Object.assign(this, options) } }
  const { LotusBilibili } = await import("../apps/bilibili.js")
  const app = new LotusBilibili()
  assert.equal(typeof app.task[0].fnc, "function")
  assert.equal(app.task[0].cron, "0 20 4 * * ? *")
})
