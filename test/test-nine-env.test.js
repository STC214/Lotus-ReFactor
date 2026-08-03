import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { TestNineEnvService } from "../services/testNine/env.js"

test("model download rejects a truncated response and atomically retries", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-test-nine-model-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const target = path.join(dir, "model.onnx")
  let downloads = 0
  const service = new TestNineEnvService({
    fetch: async (_url, options = {}) => {
      if (options.headers?.Range) {
        return new Response(new Uint8Array([1]), {
          status: 206,
          headers: { "content-range": "bytes 0-0/5", "content-length": "1" },
        })
      }
      downloads += 1
      const body = downloads === 1 ? new Uint8Array([1, 2, 3]) : new Uint8Array([1, 2, 3, 4, 5])
      return new Response(body, { status: 200 })
    },
  })
  const result = await service.downloadModel("repo", "model.onnx", target)
  assert.equal(result.attempts, 2)
  assert.equal(result.size, 5)
  assert.deepEqual([...await fs.readFile(target)], [1, 2, 3, 4, 5])
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.endsWith(".part")), [])
})

test("existing model with a mismatched remote size is replaced", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lotus-test-nine-existing-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const target = path.join(dir, "model.onnx")
  await fs.writeFile(target, new Uint8Array([1, 2]))
  const service = new TestNineEnvService({
    fetch: async (_url, options = {}) => options.headers?.Range
      ? new Response(new Uint8Array([1]), { status: 206, headers: { "content-range": "bytes 0-0/4" } })
      : new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
  })
  const result = await service.ensureModels({ model_dir: dir, model_repo: "repo", model_files: ["model.onnx"] })
  assert.equal(result.items[0].status, "downloaded")
  assert.equal(result.items[0].size, 4)
  assert.deepEqual([...await fs.readFile(target)], [1, 2, 3, 4])
})
