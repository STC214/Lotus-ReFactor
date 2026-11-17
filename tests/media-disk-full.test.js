import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { runMediaProcess } from "../services/media/files.js"

function processFixture(output, code) {
  return () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => { child.stderr.emit("data", output); child.emit("close", code) })
    return child
  }
}

for (const text of ["No space left on device", "ENOSPC", "Disk quota exceeded", "EDQUOT"]) {
  test(`media process classifies ${text} without returning raw process logs`, async () => {
    await assert.rejects(runMediaProcess("ffmpeg", [], { spawnImpl: processFixture(`private process detail: ${text}`, 1) }), error => {
      assert.equal(error.code, "ENOSPC")
      assert.match(error.message, /磁盘空间不足/)
      assert.doesNotMatch(error.message, /private process detail/)
      return true
    })
  })
}

test("successful output mentioning disk space is not turned into failure", async () => {
  assert.equal((await runMediaProcess("ffmpeg", [], { spawnImpl: processFixture("No space left on device", 0) })).code, 0)
})

test("ordinary failures retain their original diagnostic", async () => {
  await assert.rejects(runMediaProcess("ffmpeg", [], { spawnImpl: processFixture("codec rejected", 1) }), /codec rejected/)
})
