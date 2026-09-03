import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { StarRailGachaDisplayBridge } from "../services/pluginBridge/starRailGacha.js"

const sample = { pools: { GachaType_AvatarUp: { pity: 1, totalDraws: 1, fiveStars: [] } } }

test("star rail render uses a temporary identity and removes it on success and failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-gacha-render-"))
  class Log { async getLogData() { return { ok: true } } }
  class Renderer { async renderImg() { return "image" } }
  const bridge = new StarRailGachaDisplayBridge({ storageRoot: root, loadGachaLog: async () => Log, loadGcLogApp: async () => Renderer })
  try {
    assert.equal((await bridge.render({ e: {}, uid: "100000001", data: sample })).image, "image")
    assert.deepEqual(await fs.readdir(root), [])
    bridge.loadGcLogApp = async () => class { async renderImg() { throw new Error("render failed") } }
    await assert.rejects(() => bridge.render({ e: {}, uid: "100000001", data: sample }), /render failed/)
    assert.deepEqual(await fs.readdir(root), [])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("legacy restore requires confirmation and backs up current data before replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-gacha-restore-"))
  const storageRoot = path.join(root, "srJson")
  const backupRoot = path.join(root, "srJson.backup")
  const restoreBackupRoot = path.join(root, "srJson.pre-restore")
  const bridge = new StarRailGachaDisplayBridge({ storageRoot, backupRoot, restoreBackupRoot })
  const target = path.join(storageRoot, "1", "100000001")
  const source = path.join(backupRoot, "1", "100000001")
  await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, "11.json"), "current")
  await fs.mkdir(source, { recursive: true }); await fs.writeFile(path.join(source, "11.json"), "original")
  try {
    await assert.rejects(() => bridge.restoreLegacyBackup({ qq: "1", uid: "100000001" }), /确认/)
    const result = await bridge.restoreLegacyBackup({ qq: "1", uid: "100000001", confirm: true })
    assert.equal(await fs.readFile(path.join(target, "11.json"), "utf8"), "original")
    assert.equal(await fs.readFile(path.join(result.safetyBackup, "11.json"), "utf8"), "current")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("legacy restore puts the current directory back when the final rename fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-gacha-restore-failure-"))
  const storageRoot = path.join(root, "srJson")
  const backupRoot = path.join(root, "srJson.backup")
  const restoreBackupRoot = path.join(root, "srJson.pre-restore")
  const target = path.join(storageRoot, "1", "100000001")
  const source = path.join(backupRoot, "1", "100000001")
  await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, "11.json"), "current")
  await fs.mkdir(source, { recursive: true }); await fs.writeFile(path.join(source, "11.json"), "original")
  const bridge = new StarRailGachaDisplayBridge({
    storageRoot,
    backupRoot,
    restoreBackupRoot,
    rename: async () => { throw new Error("injected rename failure") },
  })
  try {
    await assert.rejects(
      () => bridge.restoreLegacyBackup({ qq: "1", uid: "100000001", confirm: true }),
      /已从安全备份恢复原目录/,
    )
    assert.equal(await fs.readFile(path.join(target, "11.json"), "utf8"), "current")
    assert.equal(await fs.readFile(path.join(source, "11.json"), "utf8"), "original")
    assert.equal((await fs.readdir(storageRoot)).some(name => name.startsWith(".lotus-restore-")), false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
