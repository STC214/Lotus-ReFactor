import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { loadGenshinMysApi } from "../services/dailyNote/service.js"

test("daily note finds the genshin MysApi module case-insensitively on Linux", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-mys-api-"))
  const directory = path.join(root, "plugins", "genshin", "model", "mys")
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "mysApi.js"), "export default class MysApi {}\n")

  const MysApi = await loadGenshinMysApi({ root })
  assert.equal(typeof MysApi, "function")
  assert.equal(MysApi.name, "MysApi")
})

test("daily note reports an actionable error when MysApi is absent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-mys-api-missing-"))
  await fs.mkdir(path.join(root, "plugins", "genshin", "model", "mys"), { recursive: true })
  await assert.rejects(
    loadGenshinMysApi({ root }),
    /genshin MysApi module is missing/,
  )
})
