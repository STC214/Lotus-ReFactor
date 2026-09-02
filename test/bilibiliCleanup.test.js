import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createDefaultGlobalConfig } from "../core/config/defaults.js"
import { BilibiliService, normalizeDownloadConfig } from "../services/bilibili/service.js"

test("Bilibili defaults use disk-saving post-send cleanup", () => {
  const config = createDefaultGlobalConfig().bilibili
  assert.equal(config.download.cache_enable, false)
  assert.equal(config.cleanup.enable, true)
  assert.equal(config.cleanup.delete_after_send, true)
  assert.equal(normalizeDownloadConfig({}).cache_enable, false)
  assert.equal(normalizeDownloadConfig({ cache_enable: true }).cache_enable, true)
})

test("Bilibili cleanup stays inside its directories and reconciles cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-bilibili-cleanup-"))
  try {
    const tmpDir = path.join(root, "tmp")
    const outputDir = path.join(root, "downloads")
    const cacheFile = path.join(root, "cache.yaml")
    const outside = path.join(root, "outside.mp4")
    const stale = path.join(outputDir, "stale.mp4")
    const fresh = path.join(outputDir, "fresh.mp4")
    const staleTmp = path.join(tmpDir, "stale-job")
    await fs.mkdir(outputDir, { recursive: true })
    await fs.mkdir(staleTmp, { recursive: true })
    await fs.writeFile(outside, Buffer.alloc(10))
    await fs.writeFile(stale, Buffer.alloc(20))
    await fs.writeFile(fresh, Buffer.alloc(30))
    await fs.writeFile(path.join(staleTmp, "part.m4s"), Buffer.alloc(40))
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    await fs.utimes(stale, old, old)
    await fs.utimes(staleTmp, old, old)

    const service = new BilibiliService({ tmpDir, outputDir, cacheFile })
    await service.writeCache({
      stale: { files: [stale, outside], expires_at: "" },
      fresh: { files: [fresh], expires_at: "" },
    })
    const result = await service.cleanupDownloads({
      cache_enable: false,
      cleanup: { enable: true, retention_days: 1, tmp_retention_hours: 6, max_total_size_mb: 0 },
    })

    assert.equal(await exists(stale), false)
    assert.equal(await exists(staleTmp), false)
    assert.equal(await exists(outside), true)
    assert.equal(await exists(fresh), true)
    assert.deepEqual(Object.keys(await service.readCache()), ["fresh"])
    assert.equal(result.removedFiles, 2)

    const released = await service.releaseDownloadedFiles([fresh, outside])
    assert.equal(released.removedFiles, 1)
    assert.equal(await exists(fresh), false)
    assert.equal(await exists(outside), true)
    assert.deepEqual(await service.readCache(), {})
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function exists(file) {
  return fs.stat(file).then(() => true, () => false)
}
